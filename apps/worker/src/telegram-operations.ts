import { createDatabaseConnection } from '@atodotren/db';
import { createLogger } from '@atodotren/observability';

import { executeCallback, executeTelegramCommand, parseTelegramCommand, type CommandResponse } from './telegram-commands.js';
import { deliverIngestionIncidents } from './telegram-alerts.js';
import { loadTelegramOperationsConfig, type TelegramOperationsConfig } from './telegram-config.js';
import { TelegramOperationalMonitor } from './telegram-monitor.js';
import { runDigestCheck } from './telegram-scheduler.js';
import { ResourceCollector } from './resources.js';
import { ReportingService } from './reporting-service.js';
import { TelegramStateStore } from './telegram-state.js';
import { TelegramBotApi, type TelegramUpdate } from './telegram-transport.js';

export interface TelegramOperationsDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly connect?: typeof createDatabaseConnection;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

class UnauthorizedLogLimiter {
  readonly #last = new Map<string, number>();

  public allow(senderId: string, chatId: string, now: number): boolean {
    const key = `${senderId}:${chatId}`;
    const previous = this.#last.get(key) ?? 0;
    if (now - previous < 60_000) return false;
    this.#last.set(key, now);
    if (this.#last.size > 100) {
      for (const [candidate, timestamp] of this.#last) {
        if (now - timestamp > 300_000) this.#last.delete(candidate);
      }
    }
    return true;
  }
}

export function isAuthorizedUpdate(update: TelegramUpdate, config: TelegramOperationsConfig): boolean {
  const sender = update.message?.from ?? update.callback_query?.from;
  const chat = update.message?.chat ?? update.callback_query?.message?.chat;
  return sender !== undefined
    && chat !== undefined
    && String(sender.id) === config.allowedUserId
    && String(chat.id) === config.privateChatId
    && chat.type === 'private';
}

export async function runTelegramOperations(
  config: TelegramOperationsConfig,
  options: { readonly signal: AbortSignal; readonly dependencies?: TelegramOperationsDependencies },
): Promise<void> {
  const dependencies = options.dependencies ?? {};
  const now = dependencies.now ?? (() => new Date());
  const logger = createLogger({ service: 'atodotren-telegram', level: config.logLevel });
  if (!config.enabled) {
    logger.info('telegram.disabled', 'Telegram operations service is disabled');
    await waitForAbort(options.signal);
    return;
  }
  if (config.botToken === undefined || config.privateChatId === undefined || config.allowedUserId === undefined) {
    throw new Error('Enabled Telegram operations service is missing validated credentials or identifiers');
  }
  const connection = await (dependencies.connect ?? createDatabaseConnection)(config.database);
  const reporting = new ReportingService(connection.pool, now);
  const state = new TelegramStateStore({
    pool: connection.pool,
    reportVersion: config.reportVersion,
    retentionDays: config.deliveryRetentionDays,
    callbackTtlMs: config.callbackTtlMs,
  });
  const resources = new ResourceCollector({ reporting, hostMetrics: config.hostMetrics });
  const telegram = new TelegramBotApi({
    token: config.botToken,
    baseUrl: config.apiBaseUrl,
    ...(dependencies.fetchImplementation === undefined ? {} : { fetchImplementation: dependencies.fetchImplementation }),
  });
  const monitor = new TelegramOperationalMonitor({ reporting, resources, state, telegram, config });
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    await telegram.assertLongPollingAvailable(options.signal);
    releaseLock = await state.acquireLongPollLock();
    await telegram.registerCommands(config.privateChatId, options.signal);
    logger.info('telegram.started', 'Telegram long polling is active', {
      allowedUserId: Number(config.allowedUserId), privateChatId: Number(config.privateChatId),
      reportVersion: config.reportVersion,
    });
    await pollingLoop({ config, reporting, state, resources, telegram, monitor, signal: options.signal, now, logger });
  } finally {
    try {
      await releaseLock?.();
    } finally {
      await connection.close();
    }
  }
}

async function pollingLoop(options: {
  readonly config: TelegramOperationsConfig;
  readonly reporting: ReportingService;
  readonly state: TelegramStateStore;
  readonly resources: ResourceCollector;
  readonly telegram: TelegramBotApi;
  readonly monitor: TelegramOperationalMonitor;
  readonly signal: AbortSignal;
  readonly now: () => Date;
  readonly logger: ReturnType<typeof createLogger>;
}): Promise<void> {
  const unauthorizedLogs = new UnauthorizedLogLimiter();
  let offset = await options.state.nextUpdateId();
  let nextMaintenanceAt = 0;
  let nextPruneAt = 0;
  while (!options.signal.aborted) {
    let updates: readonly TelegramUpdate[] = [];
    try {
      updates = await options.telegram.getUpdates(offset, options.config.pollTimeoutSeconds, options.signal);
    } catch (error) {
      if (options.signal.aborted) break;
      options.logger.warn('telegram.poll_failed', 'Telegram long poll failed', { error });
    }
    for (const update of [...updates].sort((left, right) => left.update_id - right.update_id)) {
      if (update.update_id < offset) continue;
      const handled = await processUpdate({ ...options, update, unauthorizedLogs });
      if (!handled) break;
      await options.state.confirmUpdate(update.update_id);
      offset = Math.max(offset, update.update_id + 1);
    }
    const current = options.now();
    if (current.getTime() >= nextMaintenanceAt && !options.signal.aborted) {
      try {
        await options.monitor.evaluate(current, options.signal);
      } catch (error) {
        options.logger.warn('telegram.monitor_failed', 'Telegram operational monitor evaluation failed', { error });
      }
      try {
        await runDigestCheck({
          now: current, config: options.config, reporting: options.reporting,
          state: options.state, telegram: options.telegram, signal: options.signal,
        });
        await deliverIngestionIncidents({
          now: current, config: options.config, reporting: options.reporting,
          state: options.state, telegram: options.telegram, signal: options.signal,
        });
      } catch (error) {
        options.logger.warn('telegram.maintenance_failed', 'Telegram scheduled maintenance failed', { error });
      }
      nextMaintenanceAt = current.getTime() + 60_000;
    }
    if (current.getTime() >= nextPruneAt && !options.signal.aborted) {
      try {
        await options.state.prune();
      } catch (error) {
        options.logger.warn('telegram.prune_failed', 'Telegram state retention pass failed', { error });
      }
      nextPruneAt = current.getTime() + 3_600_000;
    }
  }
  options.logger.info('telegram.stopping', 'Telegram long polling stopped');
}

async function processUpdate(options: {
  readonly update: TelegramUpdate;
  readonly config: TelegramOperationsConfig;
  readonly reporting: ReportingService;
  readonly state: TelegramStateStore;
  readonly resources: ResourceCollector;
  readonly telegram: TelegramBotApi;
  readonly signal: AbortSignal;
  readonly now: () => Date;
  readonly logger: ReturnType<typeof createLogger>;
  readonly unauthorizedLogs: UnauthorizedLogLimiter;
}): Promise<boolean> {
  const sender = options.update.message?.from ?? options.update.callback_query?.from;
  const chat = options.update.message?.chat ?? options.update.callback_query?.message?.chat;
  if (!isAuthorizedUpdate(options.update, options.config)) {
    const senderId = sender === undefined ? '0' : String(sender.id);
    const chatId = chat === undefined ? '0' : String(chat.id);
    if (options.unauthorizedLogs.allow(senderId, chatId, options.now().getTime())) {
      options.logger.warn('telegram.unauthorized', 'Unauthorized Telegram update ignored', {
        updateId: options.update.update_id, senderId: Number(senderId), chatId: Number(chatId),
        chatType: chat?.type ?? 'missing',
      });
    }
    return true;
  }
  const prior = await options.state.deliveryForUpdate(options.update.update_id);
  if (prior?.delivered === true) return true;
  let response: CommandResponse;
  try {
    const callback = options.update.callback_query;
    if (callback !== undefined) {
      if (callback.data === undefined) return true;
      response = await executeCallback({ callbackData: callback.data, reporting: options.reporting, state: options.state });
    } else {
      const text = options.update.message?.text;
      if (text === undefined) return true;
      const command = parseTelegramCommand(text, options.now());
      response = await executeTelegramCommand({ command, reporting: options.reporting, resources: options.resources, state: options.state });
    }
  } catch (error) {
    response = { text: error instanceof RangeError ? `${error.message}\nUse /help for syntax.` : 'The report could not be produced. Use /status for current operational state.' };
  }
  const deliveryKey = `update:${options.update.update_id}:${options.config.reportVersion}`;
  const reservation = await options.state.beginDelivery({ key: deliveryKey, type: 'command', updateId: options.update.update_id });
  if (reservation.delivered) return true;
  const text = response.chart === undefined ? response.text : `${response.text}\n${chartFallback(response.chart)}`;
  try {
    const sent = await options.telegram.sendMessage(options.config.privateChatId ?? '', text, { buttons: response.buttons }, options.signal);
    await options.state.markDelivered(deliveryKey, sent.message_id);
    if (options.update.callback_query !== undefined) {
      await options.telegram.answerCallbackQuery(options.update.callback_query.id, options.signal);
    }
    return true;
  } catch (error) {
    await options.state.markFailed(deliveryKey, error instanceof Error ? error.name : 'DeliveryError');
    options.logger.warn('telegram.delivery_failed', 'Telegram command delivery failed', {
      updateId: options.update.update_id,
      errorName: error instanceof Error ? error.name : 'NonError',
    });
    return false;
  }
}

function chartFallback(chart: NonNullable<CommandResponse['chart']>): string {
  const points = chart.points.slice(0, 24).map((point) => `${point.x}=${point.y === null ? 'n/a' : point.y.toFixed(1)}s(n=${point.sampleSize})`).join(' · ');
  return `Chart data (${chart.title}; PNG renderer deferred in CI-only phase): ${points || 'no points'}`;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

export async function executeTelegramOperationsCli(
  dependencies: TelegramOperationsDependencies = {},
): Promise<0 | 1> {
  const controller = new AbortController();
  const config = loadTelegramOperationsConfig(dependencies.environment ?? process.env);
  const shutdown = (): void => controller.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await runTelegramOperations(config, { signal: controller.signal, dependencies });
    return 0;
  } catch (error) {
    const logger = createLogger({ service: 'atodotren-telegram', level: config.logLevel });
    logger.error('telegram.failed', 'Telegram operations service stopped with an error', { error });
    return 1;
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}
