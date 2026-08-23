import type { Measurement, ResourceCollector } from './resources.js';
import type { ReportingService } from './reporting-service.js';
import type { TelegramOperationsConfig } from './telegram-config.js';
import type { TelegramStateStore } from './telegram-state.js';
import type { TelegramBotApi } from './telegram-transport.js';

interface MonitorRow {
  readonly monitor_key: string;
  readonly opened_at: Date | string;
  readonly last_observed_at: Date | string;
  readonly consecutive_count: number | string;
  readonly is_open: boolean;
  readonly recovered_at: Date | string | null;
}

export class TelegramOperationalMonitor {
  readonly #reporting: ReportingService;
  readonly #resources: ResourceCollector;
  readonly #state: TelegramStateStore;
  readonly #telegram: TelegramBotApi;
  readonly #config: TelegramOperationsConfig;
  #postgresFailures = 0;
  #postgresAlertSent = false;

  public constructor(options: {
    readonly reporting: ReportingService;
    readonly resources: ResourceCollector;
    readonly state: TelegramStateStore;
    readonly telegram: TelegramBotApi;
    readonly config: TelegramOperationsConfig;
  }) {
    this.#reporting = options.reporting;
    this.#resources = options.resources;
    this.#state = options.state;
    this.#telegram = options.telegram;
    this.#config = options.config;
  }

  public async evaluate(now: Date, signal?: AbortSignal): Promise<void> {
    if (!(await this.#postgresAvailable())) {
      this.#postgresFailures += 1;
      if (this.#postgresFailures >= this.#config.thresholds.postgresConsecutive && !this.#postgresAlertSent) {
        try {
          await this.#telegram.sendMessage(
            this.#config.privateChatId ?? '',
            `ACTIVE · postgres.unavailable\nPostgreSQL has failed ${this.#postgresFailures} consecutive Telegram-service checks. Reporting and durable bot state are unavailable until recovery.`,
            { disableNotification: false },
            signal,
          );
          this.#postgresAlertSent = true;
        } catch {
          // PostgreSQL-outage delivery is necessarily process-local because its
          // durable marker cannot be written while PostgreSQL is unavailable.
        }
      }
      return;
    }

    if (this.#postgresFailures > 0) {
      if (this.#postgresAlertSent) {
        try {
          await this.#telegram.sendMessage(
            this.#config.privateChatId ?? '',
            'RECOVERY · postgres.unavailable\nPostgreSQL reporting access is available again.',
            { disableNotification: false },
            signal,
          );
        } catch {
          return;
        }
      }
      this.#postgresFailures = 0;
      this.#postgresAlertSent = false;
    }

    const [sample, staticAge, durableAge] = await Promise.all([
      this.#resources.collect(),
      this.#staticAgeDays(now),
      this.#durableIngestionAgeMs(now),
    ]);
    await this.#state.recordResourceSample(sample, now);
    await Promise.all([
      this.#observeValue({
        key: 'ingest.stale',
        value: durableAge,
        active: durableAge === null ? null : durableAge > this.#config.thresholds.durableIngestionStaleMs,
        critical: true,
        criticalAfterMs: 0,
        title: 'No recent successful durable ingestion',
        now,
        signal,
      }),
      this.#observeMeasurement({
        key: 'resource.cpu',
        measurement: preferred(sample.hostCpuRatio, sample.telegramProcessCpuRatio),
        predicate: (value) => value > this.#config.thresholds.cpuRatio,
        critical: true,
        criticalAfterMs: this.#config.thresholds.cpuDurationMs,
        title: 'Sustained CPU pressure',
        now,
        signal,
      }),
      this.#observeMeasurement({
        key: 'resource.memory',
        measurement: preferred(sample.hostMemoryRatio, sample.telegramContainerMemoryRatio),
        predicate: (value) => value > this.#config.thresholds.memoryRatio,
        critical: true,
        criticalAfterMs: this.#config.thresholds.memoryDurationMs,
        title: 'Sustained memory pressure',
        now,
        signal,
      }),
      this.#observeMeasurement({
        key: 'resource.disk',
        measurement: preferred(sample.hostDiskFreeRatio, sample.spoolFreeRatio),
        predicate: (value) => value < this.#config.thresholds.diskWarningRatio,
        criticalPredicate: (value) => value < this.#config.thresholds.diskCriticalRatio,
        critical: true,
        criticalAfterMs: 0,
        title: 'Critical disk capacity',
        now,
        signal,
      }),
      this.#observeValue({
        key: 'static.stale',
        value: staticAge,
        active: staticAge === null ? null : staticAge > this.#config.thresholds.staticAgeDays,
        critical: true,
        criticalAfterMs: 0,
        title: 'Static GTFS is stale',
        now,
        signal,
      }),
    ]);
  }

  async #postgresAvailable(): Promise<boolean> {
    try {
      await this.#reporting.pool.query<Record<string, unknown>>('SELECT 1 AS ok');
      return true;
    } catch {
      return false;
    }
  }

  async #staticAgeDays(now: Date): Promise<number | null> {
    try {
      const result = await this.#reporting.pool.query<Record<string, unknown>>('SELECT active_fetched_at FROM operations.report_static_age ORDER BY network_id LIMIT 1');
      const value = result.rows[0]?.active_fetched_at;
      if (value === null || value === undefined) return null;
      const instant = dateValue(value as Date | string);
      if (Number.isNaN(instant.getTime())) return null;
      return Math.max(0, (now.getTime() - instant.getTime()) / 86_400_000);
    } catch {
      return null;
    }
  }

  async #durableIngestionAgeMs(now: Date): Promise<number | null> {
    try {
      const result = await this.#reporting.pool.query<Record<string, unknown>>('SELECT last_durable_cycle_at FROM operations.report_ingest_health LIMIT 1');
      const value = result.rows[0]?.last_durable_cycle_at;
      if (value === null || value === undefined) return null;
      const instant = dateValue(value as Date | string);
      if (Number.isNaN(instant.getTime())) return null;
      return Math.max(0, now.getTime() - instant.getTime());
    } catch {
      return null;
    }
  }

  async #observeMeasurement(options: {
    readonly key: string;
    readonly measurement: Measurement<number>;
    readonly predicate: (value: number) => boolean;
    readonly criticalPredicate?: (value: number) => boolean;
    readonly critical: boolean;
    readonly criticalAfterMs: number;
    readonly title: string;
    readonly now: Date;
    readonly signal: AbortSignal | undefined;
  }): Promise<void> {
    if (!options.measurement.available || options.measurement.value === undefined) return;
    const value = options.measurement.value;
    const active = options.predicate(value);
    const critical = active && (options.criticalPredicate?.(value) ?? options.critical);
    await this.#observeValue({
      key: options.key,
      value,
      active,
      critical,
      criticalAfterMs: options.criticalAfterMs,
      title: options.title,
      now: options.now,
      signal: options.signal,
    });
  }

  async #observeValue(options: {
    readonly key: string;
    readonly value: number | null;
    readonly active: boolean | null;
    readonly critical: boolean;
    readonly criticalAfterMs: number;
    readonly title: string;
    readonly now: Date;
    readonly signal: AbortSignal | undefined;
  }): Promise<void> {
    if (options.active === null) return;
    if (!options.active) {
      const closed = await this.#reporting.pool.query<MonitorRow>(`UPDATE operations.telegram_monitor_episode
        SET is_open = false, recovered_at = $2::timestamptz, last_observed_at = $2::timestamptz
        WHERE monitor_key = $1 AND is_open
        RETURNING *`, [options.key, options.now.toISOString()]);
      const row = closed.rows[0];
      if (row === undefined) return;
      const episode = episodeKey(row);
      const activeDelivery = await this.#state.delivery(`monitor:active:${episode}`);
      if (activeDelivery?.delivered !== true) return;
      await this.#deliverOnce({
        key: `monitor:recovery:${episode}`,
        type: 'monitor_recovery',
        text: `RECOVERY · ${options.key}\n${options.title} has recovered.`,
        signal: options.signal,
      });
      return;
    }

    const opened = await this.#reporting.pool.query<MonitorRow>(`INSERT INTO operations.telegram_monitor_episode (
        monitor_key, opened_at, last_observed_at, consecutive_count, is_open, recovered_at
      ) VALUES ($1, $2::timestamptz, $2::timestamptz, 1, true, NULL)
      ON CONFLICT (monitor_key) DO UPDATE SET
        opened_at = CASE WHEN operations.telegram_monitor_episode.is_open
          THEN operations.telegram_monitor_episode.opened_at ELSE EXCLUDED.opened_at END,
        last_observed_at = EXCLUDED.last_observed_at,
        consecutive_count = CASE WHEN operations.telegram_monitor_episode.is_open
          THEN operations.telegram_monitor_episode.consecutive_count + 1 ELSE 1 END,
        is_open = true,
        recovered_at = NULL
      RETURNING *`, [options.key, options.now.toISOString()]);
    const row = opened.rows[0];
    if (row === undefined || !options.critical) return;
    if (options.now.getTime() - dateValue(row.opened_at).getTime() < options.criticalAfterMs) return;
    const rendered = options.value === null ? 'n/a' : options.value.toFixed(3);
    await this.#deliverOnce({
      key: `monitor:active:${episodeKey(row)}`,
      type: 'monitor_active',
      text: `ACTIVE · ${options.key}\n${options.title}. Current measured value: ${rendered}.\nUse /status and /resources for bounded detail.`,
      signal: options.signal,
    });
  }

  async #deliverOnce(options: {
    readonly key: string;
    readonly type: 'monitor_active' | 'monitor_recovery';
    readonly text: string;
    readonly signal: AbortSignal | undefined;
  }): Promise<void> {
    const existing = await this.#state.delivery(options.key);
    if (existing?.delivered === true) return;
    const reserved = await this.#state.beginDelivery({ key: options.key, type: options.type });
    if (reserved.delivered || reserved.attempts > 8) return;
    try {
      const sent = await this.#telegram.sendMessage(this.#config.privateChatId ?? '', options.text, { disableNotification: false }, options.signal);
      await this.#state.markDelivered(options.key, sent.message_id);
    } catch (error) {
      await this.#state.markFailed(options.key, error instanceof Error ? error.name : 'DeliveryError');
    }
  }
}

function preferred(primary: Measurement<number>, fallback: Measurement<number>): Measurement<number> {
  return primary.available ? primary : fallback;
}

function dateValue(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function episodeKey(row: MonitorRow): string {
  return `${row.monitor_key}:${dateValue(row.opened_at).toISOString()}`;
}
