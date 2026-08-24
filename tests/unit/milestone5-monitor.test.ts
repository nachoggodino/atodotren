import assert from 'node:assert/strict';
import test from 'node:test';

import type { DatabaseConnection } from '@atodotren/db';

import { executeMilestone5Cli } from '@atodotren/worker/m5-cli';
import { deliverIngestionIncidents } from '@atodotren/worker/telegram-alerts';
import { ReportingService } from '@atodotren/worker/reporting-service';
import type { ResourceCollector, ResourceSample } from '@atodotren/worker/resources';
import { loadTelegramOperationsConfig } from '@atodotren/worker/telegram-config';
import { TelegramOperationalMonitor } from '@atodotren/worker/telegram-monitor';
import type { TelegramStateStore } from '@atodotren/worker/telegram-state';
import type { TelegramBotApi } from '@atodotren/worker/telegram-transport';

const now = new Date('2026-08-23T12:00:00.000Z');

function telegramEnvironment(): Readonly<Record<string, string>> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://atodotren_telegram:fake@postgres/atodotren',
    DATABASE_SSL_MODE: 'disable',
    TELEGRAM_OPERATIONS_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: 'fake-token',
    TELEGRAM_ALLOWED_USER_ID: '101',
    TELEGRAM_PRIVATE_CHAT_ID: '202',
    TELEGRAM_API_BASE_URL: 'http://fake-telegram:4020',
    INGEST_STALE_AFTER_MS: '120000',
  };
}

function resourceSample(): ResourceSample {
  const unavailable = { available: false, reason: 'fixture unavailable' } as const;
  return {
    generatedAt: now.toISOString(),
    telegramProcessCpuRatio: unavailable,
    telegramProcessRssBytes: { available: true, value: 1024 },
    telegramContainerMemoryRatio: unavailable,
    workerContainerCpuRatio: unavailable,
    workerContainerMemoryRatio: unavailable,
    spoolBytes: { available: true, value: 2048 },
    spoolFreeRatio: { available: true, value: 0.5 },
    databaseBytes: { available: true, value: 4096 },
    databaseBreakdown: {},
    hostCpuRatio: unavailable,
    hostMemoryRatio: unavailable,
    hostDiskFreeRatio: unavailable,
  };
}

void test('Telegram-specific validation rejects invalid late-stage values', () => {
  assert.throws(() => loadTelegramOperationsConfig({
    ...telegramEnvironment(), TELEGRAM_POLL_TIMEOUT_SECONDS: '99',
  }), /TELEGRAM_POLL_TIMEOUT_SECONDS/u);
  assert.throws(() => loadTelegramOperationsConfig({
    ...telegramEnvironment(), TELEGRAM_DIGEST_READY_TIME: '07:00', TELEGRAM_DIGEST_TARGET_TIME: '05:00',
  }), /ready < target < blocked/u);
  assert.throws(() => loadTelegramOperationsConfig({
    ...telegramEnvironment(), TELEGRAM_ALERT_DISK_WARNING_RATIO: '0.05', TELEGRAM_ALERT_DISK_CRITICAL_RATIO: '0.08',
  }), /Critical disk free ratio/u);
});

void test('Milestone 5 worker path strips legacy Telegram delivery credentials', async () => {
  let transportNames: readonly string[] = ['unexpected'];
  const code = await executeMilestone5Cli(['test-notifications', '--confirm-send'], {
    environment: {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://worker:fake@postgres/atodotren', DATABASE_SSL_MODE: 'disable',
      TELEGRAM_BOT_TOKEN: 'legacy-fake-token', TELEGRAM_CHAT_ID: '999',
    },
    notificationTest: async (options) => {
      transportNames = options.transports.map((transport) => transport.name);
      return [
        { channel: 'telegram', configured: false, status: 'skipped' },
        { channel: 'smtp', configured: false, status: 'skipped' },
        { channel: 'heartbeat', configured: false, status: 'skipped' },
      ];
    },
    stdout: { write: () => true }, stderr: { write: () => true },
  });
  assert.equal(code, 0);
  assert.deepEqual(transportNames, []);
});

void test('bot monitor persists critical ingestion/static episodes and delivers once', async () => {
  const opened = new Map<string, Date>();
  const pool = {
    query: async (sql: string, parameters?: readonly unknown[]) => {
      if (sql.includes('SELECT 1 AS ok')) return { rows: [{ ok: 1 }] };
      if (sql.includes('report_static_age')) return { rows: [{ active_fetched_at: new Date(now.getTime() - 9 * 86_400_000) }] };
      if (sql.includes('report_ingest_health')) return { rows: [{ last_durable_cycle_at: new Date(now.getTime() - 180_000) }] };
      if (sql.includes('INSERT INTO operations.telegram_monitor_episode')) {
        const key = String(parameters?.[0]);
        const first = opened.get(key) ?? now;
        opened.set(key, first);
        return { rows: [{ monitor_key: key, opened_at: first, last_observed_at: now, consecutive_count: 1, is_open: true, recovered_at: null }] };
      }
      if (sql.includes('UPDATE operations.telegram_monitor_episode')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as DatabaseConnection['pool'];
  const reporting = new ReportingService(pool, () => now);
  const resources = { collect: async () => resourceSample() } as unknown as ResourceCollector;
  const delivered = new Set<string>();
  const state = {
    delivery: async (key: string) => delivered.has(key) ? { delivered: true, attempts: 1 } : undefined,
    beginDelivery: async (options: { readonly key: string }) => ({ delivered: delivered.has(options.key), attempts: 1 }),
    markDelivered: async (key: string) => { delivered.add(key); },
    markFailed: async () => undefined,
    recordResourceSample: async () => true,
  } as unknown as TelegramStateStore;
  const messages: string[] = [];
  const telegram = { sendMessage: async (_chatId: string, text: string) => { messages.push(text); return { message_id: messages.length }; } } as unknown as TelegramBotApi;
  const config = loadTelegramOperationsConfig(telegramEnvironment());
  const monitor = new TelegramOperationalMonitor({ reporting, resources, state, telegram, config });
  await monitor.evaluate(now);
  await monitor.evaluate(new Date(now.getTime() + 60_000));
  assert.equal(messages.filter((message) => message.includes('ingest · stale')).length, 1);
  assert.equal(messages.filter((message) => message.includes('static · stale')).length, 1);
});

void test('simultaneous worker ingest.stale and watchdog stale state produce one ACTIVE and one RECOVERY', async () => {
  let stale = true;
  let workerIncidentOpen = true;
  const episodes = new Map<string, { openedAt: Date; open: boolean }>();
  const pool = {
    query: async (sql: string, parameters?: readonly unknown[]) => {
      if (sql.includes('report_incident_episode')) {
        return { rows: [{ incident_key: 'ingest.stale', opened_at: now, last_observed_at: now, occurrence_count: 3, is_open: workerIncidentOpen, recovered_at: workerIncidentOpen ? null : new Date(now.getTime() + 60_000) }] };
      }
      if (sql.includes('SELECT 1 AS ok')) return { rows: [{ ok: 1 }] };
      if (sql.includes('report_static_age')) return { rows: [{ active_fetched_at: now }] };
      if (sql.includes('report_ingest_health')) return { rows: [{ last_durable_cycle_at: stale ? new Date(now.getTime() - 180_000) : new Date(now.getTime() + 59_000) }] };
      if (sql.includes('INSERT INTO operations.telegram_monitor_episode')) {
        const key = String(parameters?.[0]);
        const existing = episodes.get(key);
        const openedAt = existing?.open === true ? existing.openedAt : new Date(String(parameters?.[1]));
        episodes.set(key, { openedAt, open: true });
        return { rows: [{ monitor_key: key, opened_at: openedAt, last_observed_at: new Date(String(parameters?.[1])), consecutive_count: 1, is_open: true, recovered_at: null }] };
      }
      if (sql.includes('UPDATE operations.telegram_monitor_episode')) {
        const key = String(parameters?.[0]);
        const existing = episodes.get(key);
        if (existing?.open !== true) return { rows: [] };
        existing.open = false;
        return { rows: [{ monitor_key: key, opened_at: existing.openedAt, last_observed_at: new Date(String(parameters?.[1])), consecutive_count: 1, is_open: false, recovered_at: new Date(String(parameters?.[1])) }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as DatabaseConnection['pool'];
  const reporting = new ReportingService(pool, () => now);
  const resources = { collect: async () => resourceSample() } as unknown as ResourceCollector;
  const delivered = new Set<string>();
  const state = {
    delivery: async (key: string) => delivered.has(key) ? { delivered: true, attempts: 1, lastAttemptAt: now, messageId: 1 } : null,
    beginDelivery: async (options: { readonly key: string }) => ({ delivered: delivered.has(options.key), attempts: 1, lastAttemptAt: now, messageId: null }),
    markDelivered: async (key: string) => { delivered.add(key); },
    markFailed: async () => undefined,
    recordResourceSample: async () => true,
  } as unknown as TelegramStateStore;
  const messages: string[] = [];
  const telegram = { sendMessage: async (_chatId: string, text: string) => { messages.push(text); return { message_id: messages.length }; } } as unknown as TelegramBotApi;
  const config = loadTelegramOperationsConfig(telegramEnvironment());
  const monitor = new TelegramOperationalMonitor({ reporting, resources, state, telegram, config });

  await deliverIngestionIncidents({ config, reporting, state, telegram, now });
  await monitor.evaluate(now);
  assert.equal(messages.filter((message) => message.includes('ACTIVE INCIDENT') && message.includes('ingest · stale')).length, 1);

  stale = false;
  workerIncidentOpen = false;
  const recoveryTime = new Date(now.getTime() + 60_000);
  await deliverIngestionIncidents({ config, reporting, state, telegram, now: recoveryTime });
  await monitor.evaluate(recoveryTime);
  assert.equal(messages.filter((message) => message.includes('RECOVERED') && message.includes('ingest · stale')).length, 1);
  assert.equal(messages.filter((message) => message.includes('ingest · stale')).length, 2);
});

void test('Telegram waits for the ingestion incident threshold before delivering ACTIVE', async () => {
  let occurrenceCount = 1;
  const pool = {
    query: async () => ({ rows: [{
      incident_key: 'ingest.matching_collapse', opened_at: now, last_observed_at: now,
      occurrence_count: occurrenceCount, is_open: true, recovered_at: null,
    }] }),
  } as unknown as DatabaseConnection['pool'];
  const reporting = new ReportingService(pool, () => now);
  const delivered = new Set<string>();
  const state = {
    delivery: async (key: string) => delivered.has(key) ? { delivered: true, attempts: 1, lastAttemptAt: now } : null,
    beginDelivery: async (options: { readonly key: string }) => ({ delivered: delivered.has(options.key), attempts: 1, lastAttemptAt: now }),
    markDelivered: async (key: string) => { delivered.add(key); },
    markFailed: async () => undefined,
  } as unknown as TelegramStateStore;
  const messages: string[] = [];
  const sendOptions: Array<Readonly<Record<string, unknown>>> = [];
  const telegram = {
    sendMessage: async (_chat: string, text: string, options: Readonly<Record<string, unknown>>) => {
      messages.push(text);
      sendOptions.push(options);
      return { message_id: messages.length };
    },
  } as unknown as TelegramBotApi;
  const config = loadTelegramOperationsConfig(telegramEnvironment());

  await deliverIngestionIncidents({ config, reporting, state, telegram, now });
  occurrenceCount = 2;
  await deliverIngestionIncidents({ config, reporting, state, telegram, now });
  assert.equal(messages.length, 0);

  occurrenceCount = 3;
  await deliverIngestionIncidents({ config, reporting, state, telegram, now });
  await deliverIngestionIncidents({ config, reporting, state, telegram, now });
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? '', /ACTIVE INCIDENT/u);
  assert.match(messages[0] ?? '', /Confirmed observations: <b>3<\/b>/u);
  assert.equal(sendOptions[0]?.parseMode, 'HTML');
});
