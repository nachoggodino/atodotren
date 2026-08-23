import { readFile, writeFile } from 'node:fs/promises';

import { createDatabaseConnection } from '@atodotren/db';
import { createLogger, installProcessSafetyHandlers, ShutdownCoordinator } from '@atodotren/observability';

import { executeCallback, executeTelegramCommand, parseTelegramCommand, type CommandResponse } from './telegram-commands.js';
import { loadTelegramDeliveryConfig, loadTelegramOperationsConfig, type TelegramOperationsConfig } from './telegram-config.js';
import { deliverIngestionIncidents } from './telegram-alerts.js';
import { TelegramOperationalMonitor } from './telegram-monitor.js';
import { ReportingService } from './reporting-service.js';
import { ResourceCollector } from './resources.js';
import { runDigestCheck } from './telegram-scheduler.js';
import { TelegramStateStore } from './telegram-state.js';
import {
  TelegramApiError,
  TelegramBotApi,
  type TelegramUpdate,
} from './telegram-transport.js';

const TELEGRAM_HEALTH_PATH = '/tmp/atodotren-telegram-health.json';
const POLL_BACKOFF_BASE_MS = 1_000;
const POLL_BACKOFF_EXPONENTIAL_CAP_MS = 30_000;
const POLL_BACKOFF_MAX_MS = 300_000;
const POLL_BACKOFF_JITTER_RATIO = 0.20;
const HEALTH_GRACE_MS = 30_000;
const DATABASE_UNAVAILABLE_TEXT = 'Reporting database unavailable. The bot is still polling; retry after PostgreSQL recovers.';

type Logger = ReturnType<typeof createLogger>;
type Sleep = (milliseconds: number) => Promise<void>;
type ProcessUpdateResult = 'handled' | 'deferred' | 'delivery-failed';

export interface TelegramOperationsDependencies {
  readonly connect?: typeof createDatabaseConnection;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
  readonly sleep?: Sleep;
  readonly healthWriter?: (atMs: number) => Promise<void>;
  readonly stdout?: Pick<NodeJS.WritableStream, 'write'>;
  readonly stderr?: Pick<NodeJS.WritableStream, 'write'>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export class TelegramPollBackoff {
  #failures = 0;
  readonly #random: () => number;

  public constructor(random: () => number = Math.random) {
    this.#random = random;
  }

  public get failures(): number {
    return this.#failures;
  }

  public recordSuccess(): number {
    const previous = this.#failures;
    this.#failures = 0;
    return previous;
  }

  public recordFailure(error: unknown): number {
    this.#failures += 1;
    const exponent = Math.min(10, this.#failures - 1);
    const exponential = Math.min(POLL_BACKOFF_EXPONENTIAL_CAP_MS, POLL_BACKOFF_BASE_MS * 2 ** exponent);
    const random = Math.max(0, Math.min(1, this.#random()));
    const jitter = Math.floor(exponential * POLL_BACKOFF_JITTER_RATIO * random);
    const retryAfterMs = error instanceof TelegramApiError && error.retryAfterSeconds !== undefined
      ? error.retryAfterSeconds * 1_000
      : 0;
    return Math.min(POLL_BACKOFF_MAX_MS, Math.max(exponential + jitter, retryAfterMs));
  }
}

export async function waitForAbortableDelay(
  milliseconds: number,
  signal: AbortSignal,
  sleep: Sleep = defaultSleep,
): Promise<void> {
  if (signal.aborted || milliseconds <= 0) return;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    abortListener = () => resolve();
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    await Promise.race([sleep(milliseconds), aborted]);
  } finally {
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
  }
}

export async function telegramHealthStatus(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  nowMs: number = Date.now(),
  reader: (path: string) => Promise<string> = async (path) => readFile(path, 'utf8'),
): Promise<boolean> {
  const enabled = environment.TELEGRAM_OPERATIONS_ENABLED?.trim();
  if (enabled === undefined || enabled === '' || enabled === 'false') return true;
  if (enabled !== 'true') return false;
  const pollTimeoutSeconds = Number(environment.TELEGRAM_POLL_TIMEOUT_SECONDS ?? '25');
  if (!Number.isSafeInteger(pollTimeoutSeconds) || pollTimeoutSeconds < 1 || pollTimeoutSeconds > 50) return false;
  try {
    const parsed = JSON.parse(await reader(TELEGRAM_HEALTH_PATH)) as { readonly lastProgressAtMs?: unknown };
    const lastProgressAtMs = Number(parsed.lastProgressAtMs);
    const ageMs = nowMs - lastProgressAtMs;
    return Number.isFinite(lastProgressAtMs)
      && ageMs >= 0
      && ageMs <= pollTimeoutSeconds * 1_000 + HEALTH_GRACE_MS;
  } catch {
    return false;
  }
}

async function writeHealthProgress(atMs: number): Promise<void> {
  await writeFile(TELEGRAM_HEALTH_PATH, `${JSON.stringify({ lastProgressAtMs: atMs })}\n`, { encoding: 'utf8', mode: 0o600 });
}

export class TelegramUpdateFallbackState {
  readonly #maxEntries: number;
  readonly #notices = new Set<number>();
  readonly #delivered = new Map<number, { readonly key: string; readonly messageId: number }>();

  public constructor(maxEntries = 100) {
    this.#maxEntries = maxEntries;
  }

  public noticeSent(updateId: number): boolean {
    return this.#notices.has(updateId);
  }

  public markNotice(updateId: number): void {
    this.#notices.add(updateId);
    this.#trimSet(this.#notices);
  }

  public localDelivery(updateId: number): { readonly key: string; readonly messageId: number } | undefined {
    return this.#delivered.get(updateId);
  }

  public markLocalDelivery(updateId: number, key: string, messageId: number): void {
    this.#delivered.set(updateId, { key, messageId });
    while (this.#delivered.size > this.#maxEntries) {
      const oldest = this.#delivered.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.#delivered.delete(oldest);
    }
  }

  public clear(updateId: number): void {
    this.#notices.delete(updateId);
    this.#delivered.delete(updateId);
  }

  #trimSet(values: Set<number>): void {
    while (values.size > this.#maxEntries) {
      const oldest = values.values().next().value as number | undefined;
      if (oldest === undefined) break;
      values.delete(oldest);
    }
  }
}

export function isReportingDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  return code.startsWith('08')
    || ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03'].includes(code)
    || /connection terminated|connection closed|database system is starting up|database system is shutting down/iu.test(error.message);
}

export async function runTelegramOperations(
  config: TelegramOperationsConfig,
  options: { readonly signal: AbortSignal; readonly dependencies?: TelegramOperationsDependencies },
): Promise<void> {
  const logger = createLogger({ service: 'atodotren-telegram', level: config.logLevel });
  if (!config.enabled) {
    logger.info('telegram.disabled', 'Telegram operations service is disabled');
    await waitForAbort(options.signal);
    return;
  }
  const dependencies = options.dependencies ?? {};
  const connect = dependencies.connect ?? createDatabaseConnection;
  const connection = await connect({ ...config.database, applicationName: 'atodotren-telegram' });
  const reporting = new ReportingService(connection.pool, dependencies.now);
  const state = new TelegramStateStore({
    pool: connection.pool,
    reportVersion: config.reportVersion,
    retentionDays: config.deliveryRetentionDays,
    callbackTtlMs: config.callbackTtlMs,
  });
  const resources = new ResourceCollector({
    reporting,
    spoolPath: '/spool/realtime.sqlite',
    hostMetrics: config.hostMetrics,
  });
  const telegram = new TelegramBotApi({
    token: config.botToken ?? '',
    baseUrl: config.apiBaseUrl,
    fetchImplementation: dependencies.fetchImplementation,
  });
  const releaseLock = await state.acquireLongPollLock();
  try {
    await telegram.assertLongPollingAvailable(options.signal);
    await telegram.registerCommands(config.privateChatId ?? '', options.signal);
    await (dependencies.healthWriter ?? writeHealthProgress)(Date.now());
    const fallback = new TelegramUpdateFallbackState();
    const monitor = new TelegramOperationalMonitor({ reporting, resources, state, telegram, config });
    await Promise.all([
      pollingLoop({ config, reporting, resources, state, telegram, logger, fallback, signal: options.signal, dependencies }),
      maintenanceLoop({ config, reporting, resources, state, telegram, monitor, logger, signal: options.signal, dependencies }),
    ]);
  } finally {
    await releaseLock().catch(() => undefined);
    await connection.close().catch(() => undefined);
  }
}

async function pollingLoop(options: {
  readonly config: TelegramOperationsConfig;
  readonly reporting: ReportingService;
  readonly resources: ResourceCollector;
  readonly state: TelegramStateStore;
  readonly telegram: TelegramBotApi;
  readonly logger: Logger;
  readonly fallback: TelegramUpdateFallbackState;
  readonly signal: AbortSignal;
  readonly dependencies: TelegramOperationsDependencies;
}): Promise<void> {
  let offset = await options.state.nextUpdateId();
  const retry = new TelegramPollBackoff();
  const sleep = options.dependencies.sleep ?? defaultSleep;
  const healthWriter = options.dependencies.healthWriter ?? writeHealthProgress;
  while (!options.signal.aborted) {
    let updates: readonly TelegramUpdate[];
    try {
      updates = await options.telegram.getUpdates(offset, options.config.pollTimeoutSeconds, options.signal);
    } catch (error) {
      if (options.signal.aborted) return;
      const delayMs = retry.recordFailure(error);
      if (retry.failures <= 2 || retry.failures % 5 === 0) {
        options.logger.warn('telegram.poll_failed', 'Telegram polling failed; bounded retry backoff is active', {
          consecutiveFailures: retry.failures,
          retryDelayMs: delayMs,
          failureClass: error instanceof Error ? error.name : 'UnknownError',
        });
      }
      await waitForAbortableDelay(delayMs, options.signal, sleep);
      continue;
    }
    const recoveredFailures = retry.recordSuccess();
    if (recoveredFailures > 0) {
      options.logger.info('telegram.poll_recovered', 'Telegram polling recovered', { previousConsecutiveFailures: recoveredFailures });
    }
    await healthWriter(Date.now()).catch((error) => {
      options.logger.warn('telegram.health_progress_failed', 'Telegram health progress marker could not be updated', {
        failureClass: error instanceof Error ? error.name : 'UnknownError',
      });
    });
    for (const update of updates) {
      if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
      let result: ProcessUpdateResult;
      try {
        result = await processTelegramUpdate({ ...options, update });
      } catch (error) {
        options.logger.error('telegram.update_failed', 'Telegram update handling failed safely', {
          updateId: update.update_id,
          failureClass: error instanceof Error ? error.name : 'UnknownError',
        });
        result = 'deferred';
      }
      if (result !== 'handled') break;
      try {
        await options.state.confirmUpdate(update.update_id);
        options.fallback.clear(update.update_id);
        offset = Math.max(offset, update.update_id + 1);
      } catch (error) {
        options.logger.warn('telegram.checkpoint_deferred', 'Telegram checkpoint update is deferred until PostgreSQL recovers', {
          updateId: update.update_id,
          failureClass: error instanceof Error ? error.name : 'UnknownError',
        });
        break;
      }
    }
  }
}

export async function processTelegramUpdate(options: {
  readonly update: TelegramUpdate;
  readonly config: TelegramOperationsConfig;
  readonly reporting: ReportingService;
  readonly resources: ResourceCollector;
  readonly state: TelegramStateStore;
  readonly telegram: TelegramBotApi;
  readonly logger: Pick<Logger, 'warn'>;
  readonly fallback: TelegramUpdateFallbackState;
  readonly signal?: AbortSignal;
}): Promise<ProcessUpdateResult> {
  const { update, config, state, telegram, fallback } = options;
  if (!isAuthorizedUpdate(update, config)) {
    options.logger.warn('telegram.unauthorized', 'Ignored unauthorized Telegram update', { updateId: update.update_id });
    return 'handled';
  }
  const deliveryKey = `command:${update.update_id}:${config.reportVersion}`;
  const localDelivery = fallback.localDelivery(update.update_id);
  if (localDelivery !== undefined) {
    try {
      const reserved = await state.beginDelivery({ key: localDelivery.key, type: 'command', updateId: update.update_id });
      if (!reserved.delivered) await state.markDelivered(localDelivery.key, localDelivery.messageId);
      return 'handled';
    } catch (error) {
      if (isReportingDatabaseUnavailable(error)) return 'deferred';
      throw error;
    }
  }

  try {
    const previous = await state.deliveryForUpdate(update.update_id);
    if (previous?.delivered === true) return 'handled';
  } catch (error) {
    if (isReportingDatabaseUnavailable(error)) return databaseUnavailableUpdate(options);
    throw error;
  }

  let response: CommandResponse;
  try {
    if (update.callback_query !== undefined) {
      response = await executeCallback({
        callbackData: update.callback_query.data ?? '',
        reporting: options.reporting,
        state,
      });
    } else {
      response = await executeTelegramCommand({
        command: parseTelegramCommand(update.message?.text ?? '', options.reporting.now()),
        reporting: options.reporting,
        resources: options.resources,
        state,
      });
    }
  } catch (error) {
    if (isReportingDatabaseUnavailable(error)) return databaseUnavailableUpdate(options);
    response = {
      text: error instanceof RangeError
        ? `${error.message}\nUse /help for supported syntax.`
        : 'The report could not be produced. Use /status and retry after the underlying data issue is resolved.',
    };
  }

  try {
    const reserved = await state.beginDelivery({ key: deliveryKey, type: 'command', updateId: update.update_id });
    if (reserved.delivered) return 'handled';
  } catch (error) {
    if (isReportingDatabaseUnavailable(error)) return databaseUnavailableUpdate(options);
    throw error;
  }

  try {
    const sent = await telegram.sendMessage(config.privateChatId ?? '', response.text, {
      buttons: response.buttons,
      disableNotification: true,
    }, options.signal);
    fallback.markLocalDelivery(update.update_id, deliveryKey, sent.message_id);
    try {
      await state.markDelivered(deliveryKey, sent.message_id);
    } catch (error) {
      if (isReportingDatabaseUnavailable(error)) return 'deferred';
      throw error;
    }
    if (update.callback_query !== undefined) {
      await telegram.answerCallbackQuery(update.callback_query.id, options.signal);
    }
    return 'handled';
  } catch (error) {
    try {
      await state.markFailed(deliveryKey, error instanceof Error ? error.name : 'DeliveryError');
    } catch {
      // The original delivery failure remains authoritative; a database failure
      // here must not terminate the polling service.
    }
    return 'delivery-failed';
  }
}

async function databaseUnavailableUpdate(options: {
  readonly update: TelegramUpdate;
  readonly config: TelegramOperationsConfig;
  readonly telegram: TelegramBotApi;
  readonly fallback: TelegramUpdateFallbackState;
  readonly signal?: AbortSignal;
}): Promise<ProcessUpdateResult> {
  if (options.fallback.noticeSent(options.update.update_id)) return 'deferred';
  try {
    await options.telegram.sendMessage(
      options.config.privateChatId ?? '',
      DATABASE_UNAVAILABLE_TEXT,
      { disableNotification: true },
      options.signal,
    );
    options.fallback.markNotice(options.update.update_id);
  } catch {
    return 'delivery-failed';
  }
  return 'deferred';
}

async function maintenanceLoop(options: {
  readonly config: TelegramOperationsConfig;
  readonly reporting: ReportingService;
  readonly resources: ResourceCollector;
  readonly state: TelegramStateStore;
  readonly telegram: TelegramBotApi;
  readonly monitor: TelegramOperationalMonitor;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly dependencies: TelegramOperationsDependencies;
}): Promise<void> {
  const sleep = options.dependencies.sleep ?? defaultSleep;
  while (!options.signal.aborted) {
    const now = options.dependencies.now?.() ?? new Date();
    const tasks = [
      deliverIngestionIncidents({ ...options, now }),
      options.monitor.evaluate(now, options.signal),
      runDigestCheck({ ...options, now }),
      options.state.prune(),
    ];
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === 'rejected') {
        options.logger.warn('telegram.maintenance_failed', 'A Telegram maintenance task failed without stopping long polling', {
          failureClass: result.reason instanceof Error ? result.reason.name : 'UnknownError',
        });
      }
    }
    await waitForAbortableDelay(60_000, options.signal, sleep);
  }
}

export function isAuthorizedUpdate(update: TelegramUpdate, config: TelegramOperationsConfig): boolean {
  const message = update.message ?? update.callback_query?.message;
  const from = update.message?.from ?? update.callback_query?.from;
  return message?.chat.type === 'private'
    && String(message.chat.id) === config.privateChatId
    && from !== undefined
    && String(from.id) === config.allowedUserId;
}

export async function executeTelegramOperationsCli(
  dependencies: TelegramOperationsDependencies = {},
  args: readonly string[] = process.argv.slice(2),
): Promise<0 | 1 | 2> {
  const environment = dependencies.environment ?? process.env;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  if (args[0] === 'healthcheck') {
    if (args.length !== 1) return 2;
    return await telegramHealthStatus(environment) ? 0 : 1;
  }
  if (args[0] === 'test-notification') {
    if (args.length !== 2 || args[1] !== '--confirm-send') {
      stderr.write('Refusing Telegram test delivery without literal --confirm-send.\n');
      return 2;
    }
    try {
      const config = loadTelegramDeliveryConfig(environment);
      const telegram = new TelegramBotApi({
        token: config.botToken,
        baseUrl: config.apiBaseUrl,
        fetchImplementation: dependencies.fetchImplementation,
      });
      await telegram.sendMessage(
        config.privateChatId,
        'Atodotren TEST notification · manual one-shot Telegram delivery check. No operational incident was created.',
        { disableNotification: true },
      );
      stdout.write('Telegram test notification delivered.\n');
      return 0;
    } catch (error) {
      stderr.write(`Telegram test notification failed (${error instanceof Error ? error.name : 'UnknownError'}); credentials and response details were suppressed.\n`);
      return 1;
    }
  }
  if (args.length > 0) {
    stderr.write('Usage: telegram-ops [test-notification --confirm-send|healthcheck]\n');
    return 2;
  }

  let config: TelegramOperationsConfig;
  try {
    config = loadTelegramOperationsConfig(environment);
  } catch (error) {
    stderr.write(`Telegram operations configuration failed (${error instanceof Error ? error.name : 'ConfigError'}); values were suppressed.\n`);
    return 1;
  }
  const logger = createLogger({ service: 'atodotren-telegram', level: config.logLevel });
  const shutdown = new ShutdownCoordinator({ logger, timeoutMs: config.shutdownTimeoutMs });
  installProcessSafetyHandlers({ logger, shutdown });
  try {
    await runTelegramOperations(config, { signal: shutdown.signal, dependencies });
    return 0;
  } catch (error) {
    logger.error('telegram.failed', 'Telegram operations service failed', {
      failureClass: error instanceof Error ? error.name : 'UnknownError',
    });
    return 1;
  } finally {
    await shutdown.shutdown('telegram-operations-exit');
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
