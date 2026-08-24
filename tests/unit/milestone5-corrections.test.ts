import assert from 'node:assert/strict';
import test from 'node:test';

import type { DatabaseConnection } from '@atodotren/db';

import { executeCallback, executeTelegramCommand } from '@atodotren/worker/telegram-commands';
import { loadTelegramOperationsConfig } from '@atodotren/worker/telegram-config';
import {
  classifyTelegramDeliveryFailure,
  TELEGRAM_DELIVERY_MAX_ATTEMPTS,
  telegramDeliveryAbandoned,
  telegramDeliveryRetryWait,
} from '@atodotren/worker/telegram-delivery-retry';
import {
  executeTelegramOperationsCli,
  processTelegramUpdate,
  TelegramPollBackoff,
  TelegramUpdateFallbackState,
  UnauthorizedUpdateLogLimiter,
  telegramHealthStatus,
  waitForAbortableDelay,
} from '@atodotren/worker/telegram-operations';
import { formatReportText, pilotReport } from '@atodotren/worker/reporting-operations';
import { ReportingService } from '@atodotren/worker/reporting-service';
import type { ResourceCollector, ResourceSample } from '@atodotren/worker/resources';
import { runDigestCheck } from '@atodotren/worker/telegram-scheduler';
import type { TelegramStateStore } from '@atodotren/worker/telegram-state';
import { TelegramApiError, TelegramBotApi } from '@atodotren/worker/telegram-transport';

const now = new Date('2026-08-23T03:30:00.000Z');
const unavailable = { available: false, reason: 'fixture unavailable' } as const;

function telegramEnvironment(): Readonly<Record<string, string>> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://atodotren_telegram:fake@postgres/atodotren',
    DATABASE_SSL_MODE: 'disable',
    TELEGRAM_OPERATIONS_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: 'fake-token-secret',
    TELEGRAM_ALLOWED_USER_ID: '101',
    TELEGRAM_PRIVATE_CHAT_ID: '202',
    TELEGRAM_API_BASE_URL: 'http://fake-telegram:4020',
  };
}

function oneShotEnvironment(): Readonly<Record<string, string>> {
  return {
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: 'fake-token-secret',
    TELEGRAM_ALLOWED_USER_ID: '101',
    TELEGRAM_PRIVATE_CHAT_ID: '202',
    TELEGRAM_API_BASE_URL: 'http://fake-telegram:4020',
  };
}

function unavailableSample(): ResourceSample {
  return {
    generatedAt: now.toISOString(),
    telegramProcessCpuRatio: unavailable,
    telegramProcessRssBytes: unavailable,
    telegramContainerMemoryRatio: unavailable,
    workerContainerCpuRatio: unavailable,
    workerContainerMemoryRatio: unavailable,
    spoolBytes: unavailable,
    spoolFreeRatio: unavailable,
    databaseBytes: unavailable,
    databaseBreakdown: {},
    hostCpuRatio: unavailable,
    hostMemoryRatio: unavailable,
    hostDiskFreeRatio: unavailable,
  };
}

void test('poll backoff is bounded, increases, resets, and honors retry_after', () => {
  const backoff = new TelegramPollBackoff(() => 0);
  assert.equal(backoff.recordFailure(new TypeError('network failed immediately')), 1_000);
  assert.equal(backoff.recordFailure(new TypeError('network failed again')), 2_000);
  assert.equal(backoff.failures, 2);
  assert.equal(backoff.recordSuccess(), 2);
  assert.equal(backoff.failures, 0);
  assert.equal(backoff.recordFailure(new TypeError('network failed after recovery')), 1_000);
  const retryAfter = new TelegramApiError(429, 429, 7);
  assert.equal(backoff.recordFailure(retryAfter), 7_000);
  const capped = new TelegramPollBackoff(() => 1);
  let delay = 0;
  for (let index = 0; index < 20; index += 1) delay = capped.recordFailure(new TypeError('network'));
  assert.ok(delay <= 300_000);
});

void test('Bot API error parsing exposes only bounded retry_after metadata', async () => {
  const api = new TelegramBotApi({
    token: 'must-never-appear',
    baseUrl: 'http://fake-telegram:4020',
    fetchImplementation: async () => new Response(JSON.stringify({
      ok: false,
      error_code: 429,
      description: 'body detail must not be copied',
      parameters: { retry_after: 9 },
    }), { status: 429, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(api.getUpdates(0, 1), (error: unknown) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.retryAfterSeconds, 9);
    assert.doesNotMatch(error.message, /must-never-appear|body detail/u);
    return true;
  });
});

void test('abort interrupts a pending poll backoff', async () => {
  const controller = new AbortController();
  let sleeperStarted = false;
  const pending = waitForAbortableDelay(60_000, controller.signal, async () => {
    sleeperStarted = true;
    await new Promise<void>(() => undefined);
  });
  controller.abort();
  await pending;
  assert.equal(sleeperStarted, true);
});

void test('meaningful Telegram health is fresh after progress, stale later, and deliberate when disabled', async () => {
  const enabled = telegramEnvironment();
  const fresh = await telegramHealthStatus(enabled, 50_000, async () => JSON.stringify({ lastProgressAtMs: 40_000 }));
  const stale = await telegramHealthStatus(enabled, 100_000, async () => JSON.stringify({ lastProgressAtMs: 1_000 }));
  const disabled = await telegramHealthStatus({ TELEGRAM_OPERATIONS_ENABLED: 'false' }, 100_000, async () => { throw new Error('must not read'); });
  assert.equal(fresh, true);
  assert.equal(stale, false);
  assert.equal(disabled, true);
});

void test('one-shot Telegram test refuses without confirmation and sends exactly once without PostgreSQL configuration', async () => {
  const calls: Array<{ method: string; body: Readonly<Record<string, unknown>> }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = requestUrl.split('/').at(-1) ?? '';
    const rawBody = typeof init?.body === 'string' ? init.body : '{}';
    calls.push({ method, body: JSON.parse(rawBody) as Readonly<Record<string, unknown>> });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const output: string[] = [];
  const errors: string[] = [];
  const dependencies = {
    environment: oneShotEnvironment(),
    fetchImplementation: fakeFetch,
    stdout: { write: (value: string | Uint8Array) => { output.push(String(value)); return true; } },
    stderr: { write: (value: string | Uint8Array) => { errors.push(String(value)); return true; } },
  };
  assert.equal(await executeTelegramOperationsCli(dependencies, ['test-notification']), 2);
  assert.equal(calls.length, 0);
  assert.equal(await executeTelegramOperationsCli(dependencies, ['test-notification', '--confirm-send']), 0);
  assert.deepEqual(calls.map((call) => call.method), ['sendMessage']);
  assert.match(String(calls[0]?.body.text), /Atodotren TEST notification/u);
  assert.equal(String(calls[0]?.body.chat_id), '202');
  assert.equal(calls[0]?.body.disable_notification, false);
  assert.match(output.join(''), /delivered/u);
  assert.doesNotMatch(errors.join(''), /fake-token-secret/u);
});

void test('one-shot Telegram failure output remains credential-safe', async () => {
  const errors: string[] = [];
  const code = await executeTelegramOperationsCli({
    environment: oneShotEnvironment(),
    fetchImplementation: async () => new Response(JSON.stringify({ ok: false, error_code: 500, description: 'fake-token-secret response body' }), { status: 500, headers: { 'content-type': 'application/json' } }),
    stderr: { write: (value: string | Uint8Array) => { errors.push(String(value)); return true; } },
    stdout: { write: () => true },
  }, ['test-notification', '--confirm-send']);
  assert.equal(code, 1);
  assert.doesNotMatch(errors.join(''), /fake-token-secret|response body/u);
});

void test('database failure for a queued command is deferred without terminating handling and recovery resumes', async () => {
  let databaseDown = true;
  const state = {
    deliveryForUpdate: async () => {
      if (databaseDown) throw Object.assign(new Error('connection terminated'), { code: 'ECONNREFUSED' });
      return null;
    },
    beginDelivery: async () => ({ delivered: false, attempts: 1, lastAttemptAt: null, messageId: null }),
    markDelivered: async () => undefined,
    markFailed: async () => undefined,
  } as unknown as TelegramStateStore;
  const messages: string[] = [];
  const notificationModes: boolean[] = [];
  const telegram = {
    sendMessage: async (_chatId: string, text: string, sendOptions: { readonly disableNotification?: boolean }) => {
      messages.push(text);
      notificationModes.push(sendOptions.disableNotification ?? false);
      return { message_id: messages.length };
    },
  } as unknown as TelegramBotApi;
  const fallback = new TelegramUpdateFallbackState();
  const config = loadTelegramOperationsConfig(telegramEnvironment());
  const update = {
    update_id: 1,
    message: { message_id: 1, from: { id: 101 }, chat: { id: 202, type: 'private' }, text: '/help' },
  };
  const common = {
    update,
    config,
    reporting: { now: () => now } as ReportingService,
    resources: {} as ResourceCollector,
    state,
    telegram,
    logger: { warn: () => undefined },
    fallback,
  };
  assert.deepEqual(await processTelegramUpdate(common), { status: 'retry', delayMs: 5_000 });
  assert.match(messages[0] ?? '', /Reporting database unavailable/u);
  assert.deepEqual(await processTelegramUpdate(common), { status: 'retry', delayMs: 5_000 });
  assert.equal(messages.length, 1);
  databaseDown = false;
  assert.deepEqual(await processTelegramUpdate(common), { status: 'handled' });
  assert.match(messages[1] ?? '', /Atodotren operations bot/u);
  assert.deepEqual(notificationModes, [false, false]);
});

void test('unauthorized Telegram logging emits one bounded summary per five-minute window', () => {
  const limiter = new UnauthorizedUpdateLogLimiter();
  assert.deepEqual(limiter.observe(1_000), { log: true, suppressed: 0 });
  assert.deepEqual(limiter.observe(2_000), { log: false, suppressed: 1 });
  assert.deepEqual(limiter.observe(3_000), { log: false, suppressed: 2 });
  assert.deepEqual(limiter.observe(301_000), { log: true, suppressed: 2 });
});

void test('delivery retry policy honors retry_after and abandons permanent or exhausted failures', () => {
  const retryable = classifyTelegramDeliveryFailure(new TelegramApiError(429, 429, 7), 1);
  assert.deepEqual(retryable, {
    abandon: false,
    delayMs: 7_000,
    failureClass: 'TelegramApiError',
  });
  const permanent = classifyTelegramDeliveryFailure(new TelegramApiError(400, 400), 1);
  assert.equal(permanent.abandon, true);
  assert.equal(permanent.failureClass, 'Permanent.TelegramApiError');
  const exhausted = classifyTelegramDeliveryFailure(new TypeError('network'), TELEGRAM_DELIVERY_MAX_ATTEMPTS);
  assert.equal(exhausted.abandon, true);

  const record = {
    delivered: false,
    attempts: 2,
    lastAttemptAt: new Date(now.getTime() - 2_000),
    messageId: null,
    failureClass: 'TypeError',
  };
  assert.equal(telegramDeliveryRetryWait(record, now), 8_000);
  assert.equal(telegramDeliveryAbandoned({ ...record, attempts: TELEGRAM_DELIVERY_MAX_ATTEMPTS }), true);
});

void test('permanent command delivery failure is durably marked and does not block later updates', async () => {
  let failureClass = '';
  const state = {
    deliveryForUpdate: async () => null,
    beginDelivery: async () => ({ delivered: false, attempts: 1, lastAttemptAt: now, messageId: null, failureClass: null }),
    markDelivered: async () => undefined,
    markFailed: async (_key: string, value: string) => { failureClass = value; },
  } as unknown as TelegramStateStore;
  const telegram = {
    sendMessage: async () => { throw new TelegramApiError(400, 400); },
  } as unknown as TelegramBotApi;
  const result = await processTelegramUpdate({
    update: { update_id: 44, message: { message_id: 1, from: { id: 101 }, chat: { id: 202, type: 'private' }, text: '/help' } },
    config: loadTelegramOperationsConfig(telegramEnvironment()),
    reporting: { now: () => now } as ReportingService,
    resources: {} as ResourceCollector,
    state,
    telegram,
    logger: { warn: () => undefined },
    fallback: new TelegramUpdateFallbackState(),
  });
  assert.deepEqual(result, { status: 'handled' });
  assert.equal(failureClass, 'Permanent.TelegramApiError');
});

void test('/trains ambiguity preserves callback intent and completes the trains request', async () => {
  const callbacks = new Map<string, { action: 'report' | 'trains'; kind: 'line' | 'station' | 'train'; entityId: string; reportDate: string | null }>();
  let sequence = 0;
  const state = {
    createCallback: async (target: { action: 'report' | 'trains'; kind: 'line' | 'station' | 'train'; entityId: string; reportDate: string | null }) => {
      const id = `callback_${++sequence}_id`;
      callbacks.set(id, target);
      return id;
    },
    readCallback: async (id: string) => callbacks.get(id) ?? null,
  } as unknown as TelegramStateStore;
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('report_line_lookup WHERE line_id')) return { rows: [{ line_id: 1, public_code: 'C-1', name_es: 'Cercanías C-1' }] };
      if (sql.includes('report_ingest_health')) return { rows: [{ last_durable_cycle_at: now, ingest_stale: false }] };
      if (sql.includes('report_vehicle_live')) return { rows: [{ state_key: 'state-1', journey_id: 10, service_date: '2026-08-23', source_trip_id: 'trip-1', vehicle_id: 'v1', captured_at: now, current_station_name_es: 'Atocha', current_status: 'IN_TRANSIT_TO', latest_stop_delay: 30 }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as DatabaseConnection['pool'];
  const reporting = {
    now: () => now,
    pool,
    lineCandidates: async () => [
      { id: 1, label: 'Cercanías C-1', code: 'C-1', aliases: [], score: 80 },
      { id: 2, label: 'Cercanías C-10', code: 'C-10', aliases: [], score: 80 },
    ],
  } as unknown as ReportingService;
  const ambiguous = await executeTelegramCommand({
    command: { name: 'trains', query: 'C' }, reporting, resources: {} as ResourceCollector, state,
  });
  assert.match(ambiguous.text, /Select the intended line/u);
  const callbackData = ambiguous.buttons?.[0]?.[0]?.callback_data ?? '';
  const callbackId = callbackData.replace(/^r:/u, '');
  assert.equal(callbacks.get(callbackId)?.action, 'trains');
  const completed = await executeCallback({ callbackData, reporting, state });
  assert.match(completed.text, /C-1 active trains/u);
  assert.doesNotMatch(completed.text, /Run \/trains again/u);
});

void test('/trains reports no fresh vehicles when ingestion health is stale', async () => {
  let vehicleQueryRan = false;
  const reporting = {
    now: () => now,
    lineCandidates: async () => [{ id: 1, label: 'Cercanías C-1', code: 'C-1', aliases: [], score: 100 }],
    pool: {
      query: async (sql: string) => {
        if (sql.includes('report_line_lookup WHERE line_id')) {
          return { rows: [{ line_id: 1, public_code: 'C-1', name_es: 'Cercanías C-1' }] };
        }
        if (sql.includes('report_ingest_health')) {
          return { rows: [{ last_durable_cycle_at: new Date(now.getTime() - 180_000), ingest_stale: true }] };
        }
        if (sql.includes('report_vehicle_live')) vehicleQueryRan = true;
        return { rows: [] };
      },
    },
  } as unknown as ReportingService;
  const response = await executeTelegramCommand({
    command: { name: 'trains', query: 'C-1' }, reporting,
    resources: {} as ResourceCollector, state: {} as TelegramStateStore,
  });
  assert.match(response.text, /No fresh trains are available for C-1/u);
  assert.equal(vehicleQueryRan, false);
});

void test('unexpected report exceptions log only command kind and error classification', async () => {
  const logged: Array<Readonly<Record<string, unknown>>> = [];
  let delivered = '';
  const state = {
    deliveryForUpdate: async () => null,
    beginDelivery: async () => ({ delivered: false, attempts: 1, lastAttemptAt: null, messageId: null, failureClass: null }),
    markDelivered: async () => undefined,
  } as unknown as TelegramStateStore;
  const databaseError = Object.assign(new Error('SELECT secret FROM credential'), {
    name: 'error', code: '42501', detail: 'private database detail',
  });
  const result = await processTelegramUpdate({
    update: { update_id: 88, message: { message_id: 1, from: { id: 101 }, chat: { id: 202, type: 'private' }, text: '/trains C-1' } },
    config: loadTelegramOperationsConfig(telegramEnvironment()),
    reporting: { now: () => now, lineCandidates: async () => { throw databaseError; } } as unknown as ReportingService,
    resources: {} as ResourceCollector,
    state,
    telegram: { sendMessage: async (_chat: string, text: string) => { delivered = text; return { message_id: 9 }; } } as unknown as TelegramBotApi,
    logger: { warn: () => undefined, error: (_event, _message, fields) => { logged.push(fields ?? {}); } },
    fallback: new TelegramUpdateFallbackState(),
  });
  assert.deepEqual(result, { status: 'handled' });
  assert.match(delivered, /report could not be produced/u);
  assert.deepEqual(logged, [{ commandKind: 'trains', failureClass: 'error', errorCode: '42501' }]);
  assert.doesNotMatch(JSON.stringify(logged), /SELECT|secret|credential|private database detail/u);
});

void test('daily worst rankings require useful samples and label insufficient evidence', async () => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as DatabaseConnection['pool'];
  const reporting = new ReportingService(pool, () => now);
  const report = await reporting.daily('2026-08-22');
  const lineCall = calls.find((call) => call.sql.includes('report_line_summary'));
  const stationCall = calls.find((call) => call.sql.includes('report_station_summary'));
  assert.deepEqual(lineCall?.values, ['2026-08-22', 100]);
  assert.deepEqual(stationCall?.values, ['2026-08-22', 30]);
  assert.match(formatReportText(report), /Worst line: insufficient sample · Worst station: insufficient sample/u);
});

void test('scheduled daily digest includes compact resources and unavailable values are not zeroed', async () => {
  const daily = {
    contractVersion: 'report-v1' as const,
    generatedAt: now.toISOString(), timezone: 'Europe/Madrid' as const, source: 'daily_aggregate', precision: 'fixture', kind: 'daily' as const,
    serviceDate: '2026-08-22',
    finalization: { status: 'verified', finalizedAt: '2026-08-23T02:00:00.000Z', algorithmVersion: 'v1' },
    metrics: { scheduledStopOpportunities: 10, usableObservations: 8, coverage: 0.8, punctualCount: 7, punctuality: 0.875, averageArrivalDelaySeconds: 20, medianArrivalDelaySeconds: 15, canceled: 1, canceledRate: 0.1, missingEvidence: 1, missingEvidenceRate: 0.1 },
    worstLine: null, worstStation: null,
    chart: { kind: 'line' as const, title: 'trend', xLabel: 'date', yLabel: 'pct', points: [] },
  };
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('report_ingest_health')) return { rows: [{ spool_pending_count: null, last_durable_cycle_at: null }] };
      if (sql.includes('report_canonical_health')) return { rows: [{}] };
      if (sql.includes('report_finalization')) return { rows: [{}] };
      if (sql.includes('report_static_age')) return { rows: [{}] };
      if (sql.includes("count(*)::int AS count")) return { rows: [{ count: 0 }] };
      if (sql.includes('telegram_monitor_episode')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as DatabaseConnection['pool'];
  const reporting = { now: () => now, pool, daily: async () => daily } as unknown as ReportingService;
  const resources = { collect: async () => unavailableSample() } as unknown as ResourceCollector;
  let recorded = false;
  const state = {
    delivery: async () => null,
    beginDelivery: async () => ({ delivered: false, attempts: 1, lastAttemptAt: null, messageId: null }),
    markDelivered: async () => undefined,
    markFailed: async () => undefined,
    recordResourceSample: async () => { recorded = true; return false; },
  } as unknown as TelegramStateStore;
  const messages: string[] = [];
  const telegram = { sendMessage: async (_chat: string, text: string) => { messages.push(text); return { message_id: 1 }; } } as unknown as TelegramBotApi;
  const decision = await runDigestCheck({ now, config: loadTelegramOperationsConfig(telegramEnvironment()), reporting, resources, state, telegram });
  assert.equal(decision, 'normal');
  assert.equal(recorded, true);
  assert.match(messages[0] ?? '', /Resources: CPU unavailable/u);
  assert.match(messages[0] ?? '', /Storage: database unavailable/u);
  assert.match(messages[0] ?? '', /spool unavailable/u);
  assert.match(messages[0] ?? '', /pending unavailable/u);
  assert.doesNotMatch(messages[0] ?? '', /database 0 B/u);
});

void test('pilot storage projection is unavailable without separated evidence and uses measured growth when available', async () => {
  let samples: readonly Readonly<Record<string, unknown>>[] = [{ sampled_at: new Date('2026-08-23T01:00:00Z'), database_bytes: 5_000 }];
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM operations.report_feed_coverage')) return { rows: [{ first_date: '2026-08-22', last_date: '2026-08-23', service_days: 2, polls: 10, successful_polls: 9, matched_madrid: 4, response_bytes: 100 }] };
      if (sql.includes('report_database_size')) return { rows: [{ database_bytes: 5_000 }] };
      if (sql.includes('telegram_resource_sample')) return { rows: samples };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as DatabaseConnection['pool'];
  const reporting = new ReportingService(pool, () => now);
  const insufficient = await pilotReport(reporting);
  assert.equal(insufficient.projectedVariableGrowth14DaysBytes, null);
  assert.equal(insufficient.measuredDatabaseGrowthBytes, null);
  samples = [
    { sampled_at: new Date('2026-08-23T01:00:00Z'), database_bytes: 5_000 },
    { sampled_at: new Date('2026-08-22T01:00:00Z'), database_bytes: 4_000 },
  ];
  const measured = await pilotReport(reporting);
  assert.equal(measured.measuredDatabaseGrowthBytes, 1_000);
  assert.equal(measured.measuredGrowthHours, 24);
  assert.equal(measured.projectedVariableGrowth14DaysBytes, 14_000);
});
