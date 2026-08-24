import assert from 'node:assert/strict';
import test from 'node:test';

import type { DatabaseConnection } from '@atodotren/db';

import {
  approximateMedianFromHistogram,
  currentMadridServiceDate,
  normalizeLookup,
  parseReportDate,
} from '@atodotren/worker/reporting-core';
import { ReportingService } from '@atodotren/worker/reporting-service';
import { parseTelegramCommand } from '@atodotren/worker/telegram-commands';
import { loadTelegramOperationsConfig } from '@atodotren/worker/telegram-config';
import { isAuthorizedUpdate, runTelegramOperations } from '@atodotren/worker/telegram-operations';
import { decideDigest, finalizationReadyByCutoff, madridMinuteOfDay } from '@atodotren/worker/telegram-scheduler';
import {
  TelegramBotApi,
  TelegramWebhookConflictError,
  type TelegramUpdate,
} from '@atodotren/worker/telegram-transport';
import { compactCercaniasCode, escapeTelegramHtml, formatTelegramReport } from '@atodotren/worker/telegram-format';

const fixedNow = new Date('2026-08-23T11:30:00.000Z');

function enabledEnvironment(): Readonly<Record<string, string>> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://atodotren_telegram:fake@postgres/atodotren',
    DATABASE_SSL_MODE: 'disable',
    TELEGRAM_OPERATIONS_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: 'fake-token',
    TELEGRAM_ALLOWED_USER_ID: '101',
    TELEGRAM_PRIVATE_CHAT_ID: '202',
    TELEGRAM_API_BASE_URL: 'http://fake-telegram:4020',
  };
}

void test('Madrid service dates and bounded explicit dates are deterministic', () => {
  assert.equal(currentMadridServiceDate(new Date('2026-03-28T23:30:00Z')), '2026-03-29');
  assert.equal(currentMadridServiceDate(new Date('2026-10-24T22:30:00Z')), '2026-10-25');
  assert.equal(parseReportDate('yesterday', fixedNow), '2026-08-22');
  assert.equal(parseReportDate('2026-08-20', fixedNow), '2026-08-20');
  assert.throws(() => parseReportDate('2024-01-01', fixedNow), RangeError);
  assert.throws(() => parseReportDate('2026-02-30', fixedNow), RangeError);
});

void test('lookup normalization is accent-insensitive and histogram median is explicit approximation', () => {
  assert.equal(normalizeLookup('  Estación Átocha-Cercanías '), 'estacion atocha cercanias');
  const histogram = Array.from({ length: 72 }, () => 0);
  histogram[11] = 3;
  assert.equal(approximateMedianFromHistogram(histogram, 3), 15);
  assert.equal(approximateMedianFromHistogram(null, 0), null);
});

void test('command parser supports the bounded Milestone 5 syntax', () => {
  assert.deepEqual(parseTelegramCommand('/daily yesterday', fixedNow), { name: 'daily', date: '2026-08-22' });
  assert.deepEqual(parseTelegramCommand('/line C-1 2026-08-22', fixedNow), { name: 'line', query: 'C-1', date: '2026-08-22' });
  assert.deepEqual(parseTelegramCommand('/station Nuevos Ministerios', fixedNow), { name: 'station', query: 'Nuevos Ministerios' });
  assert.deepEqual(parseTelegramCommand('/trains C-1', fixedNow), { name: 'trains', query: 'C-1' });
  assert.deepEqual(parseTelegramCommand('/trains C1', fixedNow), { name: 'trains', query: 'C1' });
  assert.throws(() => parseTelegramCommand('/sql select 1', fixedNow), /Unknown command/u);
  assert.throws(() => parseTelegramCommand('/daily 2024-01-01', fixedNow), RangeError);
});

void test('authorization requires exact user, chat and private chat type', () => {
  const config = loadTelegramOperationsConfig(enabledEnvironment());
  const update: TelegramUpdate = {
    update_id: 1,
    message: { message_id: 1, from: { id: 101 }, chat: { id: 202, type: 'private' }, text: '/status' },
  };
  assert.equal(isAuthorizedUpdate(update, config), true);
  assert.equal(isAuthorizedUpdate({ ...update, message: { ...update.message!, from: { id: 102 } } }, config), false);
  assert.equal(isAuthorizedUpdate({ ...update, message: { ...update.message!, chat: { id: 203, type: 'private' } } }, config), false);
  assert.equal(isAuthorizedUpdate({ ...update, message: { ...update.message!, chat: { id: 202, type: 'group' } } }, config), false);
});

void test('compact and punctuated line codes resolve to the same exact candidate', async () => {
  const pool = {
    query: async () => ({ rows: [
      { line_id: 2, public_code: 'C-10', name_es: 'Villalba', aliases: [], normalized_slug: 'c 10' },
      { line_id: 1, public_code: 'C-1', name_es: 'Príncipe Pío - Aeropuerto T4', aliases: [], normalized_slug: 'c 1' },
      { line_id: 3, public_code: 'C-2', name_es: 'Guadalajara', aliases: [], normalized_slug: 'c 2' },
    ] }),
  } as unknown as DatabaseConnection['pool'];
  const reporting = new ReportingService(pool, () => fixedNow);
  for (const input of ['c1', 'C-1']) {
    const candidates = await reporting.lineCandidates(input);
    assert.equal(candidates.length, 3);
    assert.equal(candidates[0]?.id, 1);
    assert.equal(candidates[0]?.score, 100);
  }
});

void test('digest scheduling follows 04:00, 05:00 and 06:30 Madrid time across DST', () => {
  const spring0430 = new Date('2026-03-29T02:30:00Z');
  const spring0530 = new Date('2026-03-29T03:30:00Z');
  const spring0630 = new Date('2026-03-29T04:30:00Z');
  assert.equal(madridMinuteOfDay(spring0430), 270);
  assert.equal(decideDigest({ now: spring0430, finalized: true, readyMinute: 240, targetMinute: 300, blockedMinute: 390 }), 'waiting-target');
  assert.equal(decideDigest({ now: spring0530, finalized: true, readyMinute: 240, targetMinute: 300, blockedMinute: 390 }), 'normal');
  assert.equal(decideDigest({ now: spring0530, finalized: false, readyMinute: 240, targetMinute: 300, blockedMinute: 390 }), 'waiting-finalization');
  assert.equal(decideDigest({ now: spring0630, finalized: false, readyMinute: 240, targetMinute: 300, blockedMinute: 390 }), 'provisional');
  assert.equal(finalizationReadyByCutoff('2026-03-29T04:29:59.000Z', '2026-03-29', 390), true);
  assert.equal(finalizationReadyByCutoff('2026-03-29T04:30:00.000Z', '2026-03-29', 390), false);
  assert.equal(finalizationReadyByCutoff('2026-03-29T04:45:00.000Z', '2026-03-29', 390), false);
  const autumn0530 = new Date('2026-10-25T04:30:00Z');
  assert.equal(madridMinuteOfDay(autumn0530), 330);
});

void test('Bot API startup detects webhook conflict and command registration is chat-scoped', async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = requestUrl.split('/').at(-1) ?? '';
    const rawBody = typeof init?.body === 'string' ? init.body : '{}';
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    calls.push({ method, body });
    const result = method === 'getWebhookInfo' ? { url: '' } : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const api = new TelegramBotApi({ token: 'fake-token', baseUrl: 'http://fake', fetchImplementation: fakeFetch });
  await api.assertLongPollingAvailable();
  await api.registerCommands('202');
  await api.getUpdates(42, 25);
  const deleteScope = calls.find((call) => call.method === 'deleteMyCommands')?.body.scope as Record<string, unknown> | undefined;
  assert.equal(deleteScope?.type, 'default');
  const registration = calls.find((call) => call.method === 'setMyCommands')?.body;
  assert.deepEqual(registration?.scope, { type: 'chat', chat_id: '202' });
  const poll = calls.find((call) => call.method === 'getUpdates')?.body;
  assert.equal(poll?.offset, 42);
  assert.deepEqual(poll?.allowed_updates, ['message', 'callback_query']);
  await api.sendMessage('202', '<b>Safe &amp; readable</b>', { parseMode: 'HTML' });
  const message = calls.find((call) => call.method === 'sendMessage')?.body;
  assert.equal(message?.parse_mode, 'HTML');

  const conflictFetch = (async () => new Response(JSON.stringify({ ok: true, result: { url: 'https://example.invalid/webhook' } }), { status: 200 })) as typeof fetch;
  const conflict = new TelegramBotApi({ token: 'fake', baseUrl: 'http://fake', fetchImplementation: conflictFetch });
  await assert.rejects(conflict.assertLongPollingAvailable(), TelegramWebhookConflictError);
});

void test('Telegram HTML escaping protects dynamic Renfe and user text', () => {
  assert.equal(escapeTelegramHtml('Atocha & <C1>'), 'Atocha &amp; &lt;C1&gt;');
  assert.equal(compactCercaniasCode('C-1'), 'C1');
  assert.equal(compactCercaniasCode('C8b'), 'C8b');
});

void test('Telegram reports use neutral aggregate labels and structured escaped output', () => {
  const metrics = {
    scheduledStopOpportunities: 10, usableObservations: 8, coverage: 0.8,
    punctualCount: 7, punctuality: 0.875, averageArrivalDelaySeconds: 20,
    medianArrivalDelaySeconds: 15, canceled: 1, canceledRate: 0.1,
    missingEvidence: 1, missingEvidenceRate: 0.1,
  };
  const line = formatTelegramReport({
    contractVersion: 'report-v1', generatedAt: fixedNow.toISOString(), timezone: 'Europe/Madrid',
    source: 'daily_aggregate', precision: 'fixture', kind: 'line', serviceDate: '2026-08-22',
    line: { id: 1, name: 'Cercanías C-1', code: 'C-1' }, metrics,
    chart: { kind: 'line', title: 'trend', xLabel: 'date', yLabel: 'pct', points: [] },
  });
  assert.match(line, /📊 Stop-call aggregate/u);
  assert.doesNotMatch(line, /⏳/u);

  const status = formatTelegramReport({
    contractVersion: 'report-v1', generatedAt: fixedNow.toISOString(), timezone: 'Europe/Madrid',
    source: 'operational_views', precision: 'snapshot', kind: 'status', ingestion: null,
    canonical: null, latestFinalization: null, staticFeed: null, openIncidents: 0,
    openMonitorEpisodes: [{ monitor_key: '<unsafe&monitor>' }],
  });
  assert.match(status, /&lt;unsafe&amp;monitor&gt;/u);
  assert.doesNotMatch(status, /[{}"]+/u);
});

void test('disabled operations service shuts down cleanly without opening database or Telegram resources', async () => {
  const environment = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused:unused@unused/unused',
    DATABASE_SSL_MODE: 'disable',
    TELEGRAM_OPERATIONS_ENABLED: 'false',
  };
  const config = loadTelegramOperationsConfig(environment);
  const controller = new AbortController();
  const run = runTelegramOperations(config, {
    signal: controller.signal,
    dependencies: { connect: async () => { throw new Error('must not connect'); } },
  });
  controller.abort();
  await run;
});
