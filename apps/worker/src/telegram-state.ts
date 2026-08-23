import { randomBytes } from 'node:crypto';

import type { DatabaseConnection } from '@atodotren/db';

import { measurementValue, preferredMeasurement, type ResourceSample } from './resources.js';

type Pool = DatabaseConnection['pool'];

export interface DeliveryRecord {
  readonly delivered: boolean;
  readonly attempts: number;
  readonly lastAttemptAt: Date | null;
  readonly messageId: number | null;
  readonly failureClass: string | null;
}

export interface CallbackTarget {
  readonly kind: 'line' | 'station' | 'train';
  readonly action: 'report' | 'trains';
  readonly entityId: string;
  readonly reportDate: string | null;
}

export class TelegramStateStore {
  readonly #pool: Pool;
  readonly #reportVersion: string;
  readonly #retentionDays: number;
  readonly #callbackTtlMs: number;

  public constructor(options: {
    readonly pool: Pool;
    readonly reportVersion: string;
    readonly retentionDays: number;
    readonly callbackTtlMs: number;
  }) {
    this.#pool = options.pool;
    this.#reportVersion = options.reportVersion;
    this.#retentionDays = options.retentionDays;
    this.#callbackTtlMs = options.callbackTtlMs;
  }

  public async acquireLongPollLock(): Promise<() => Promise<void>> {
    const client = await this.#pool.connect();
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended('atodotren:telegram-long-poll', 0)) AS locked",
      );
      if (result.rows[0]?.locked !== true) throw new Error('Another Telegram operations instance already owns the long-poll advisory lock');
    } catch (error) {
      client.release();
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended('atodotren:telegram-long-poll', 0))");
      } finally {
        client.release();
      }
    };
  }

  public async nextUpdateId(): Promise<number> {
    const result = await this.#pool.query<Record<string, unknown>>('SELECT next_update_id FROM operations.telegram_checkpoint WHERE singleton');
    return Number(result.rows[0]?.next_update_id ?? 0);
  }

  public async confirmUpdate(updateId: number): Promise<void> {
    if (!Number.isSafeInteger(updateId) || updateId < 0) throw new RangeError('Invalid Telegram update id');
    await this.#pool.query<Record<string, unknown>>(`UPDATE operations.telegram_checkpoint
      SET next_update_id = GREATEST(next_update_id, $1::bigint + 1), updated_at = clock_timestamp()
      WHERE singleton`, [updateId]);
  }

  public async deliveryForUpdate(updateId: number): Promise<DeliveryRecord | null> {
    const result = await this.#pool.query<Record<string, unknown>>(`SELECT delivered_at, attempt_count, last_attempt_at, telegram_message_id, failure_class
      FROM operations.telegram_delivery WHERE source_update_id = $1`, [updateId]);
    return deliveryRecord(result.rows[0]);
  }

  public async delivery(deliveryKey: string): Promise<DeliveryRecord | null> {
    const result = await this.#pool.query<Record<string, unknown>>(`SELECT delivered_at, attempt_count, last_attempt_at, telegram_message_id, failure_class
      FROM operations.telegram_delivery WHERE delivery_key = $1`, [deliveryKey]);
    return deliveryRecord(result.rows[0]);
  }

  public async beginDelivery(options: {
    readonly key: string;
    readonly type: 'command' | 'digest_normal' | 'digest_provisional' | 'incident_active' | 'incident_recovery' | 'monitor_active' | 'monitor_recovery';
    readonly updateId?: number;
    readonly serviceDate?: string;
  }): Promise<DeliveryRecord> {
    const result = await this.#pool.query<Record<string, unknown>>(`INSERT INTO operations.telegram_delivery (
        delivery_key, delivery_type, source_update_id, service_date, report_version,
        attempt_count, first_attempt_at, last_attempt_at, expires_at
      ) VALUES ($1, $2, $3, $4::date, $5, 1, clock_timestamp(), clock_timestamp(),
        clock_timestamp() + make_interval(days => $6))
      ON CONFLICT (delivery_key) DO UPDATE SET
        attempt_count = CASE WHEN operations.telegram_delivery.delivered_at IS NULL
          THEN operations.telegram_delivery.attempt_count + 1 ELSE operations.telegram_delivery.attempt_count END,
        last_attempt_at = CASE WHEN operations.telegram_delivery.delivered_at IS NULL
          THEN clock_timestamp() ELSE operations.telegram_delivery.last_attempt_at END,
        failure_class = CASE WHEN operations.telegram_delivery.delivered_at IS NULL
          THEN NULL ELSE operations.telegram_delivery.failure_class END
      RETURNING delivered_at, attempt_count, last_attempt_at, telegram_message_id, failure_class`, [
      options.key, options.type, options.updateId ?? null, options.serviceDate ?? null,
      this.#reportVersion, this.#retentionDays,
    ]);
    const record = deliveryRecord(result.rows[0]);
    if (record === null) throw new Error('Telegram delivery reservation was not persisted');
    return record;
  }

  public async markDelivered(deliveryKey: string, messageId: number): Promise<void> {
    await this.#pool.query<Record<string, unknown>>(`UPDATE operations.telegram_delivery SET
      delivered_at = COALESCE(delivered_at, clock_timestamp()),
      telegram_message_id = COALESCE(telegram_message_id, $2), failure_class = NULL
      WHERE delivery_key = $1`, [deliveryKey, messageId]);
  }

  public async markFailed(deliveryKey: string, failureClass: string): Promise<void> {
    const bounded = /^[A-Za-z0-9_.-]{1,64}$/u.test(failureClass) ? failureClass : 'DeliveryError';
    await this.#pool.query<Record<string, unknown>>(`UPDATE operations.telegram_delivery SET failure_class = $2
      WHERE delivery_key = $1 AND delivered_at IS NULL`, [deliveryKey, bounded]);
  }

  public async createCallback(target: CallbackTarget): Promise<string> {
    const callbackId = randomBytes(12).toString('base64url');
    await this.#pool.query<Record<string, unknown>>(`INSERT INTO operations.telegram_callback (
      callback_id, entity_kind, callback_action, entity_id, report_date, expires_at
    ) VALUES ($1, $2, $3, $4, $5::date, clock_timestamp() + ($6::bigint * interval '1 millisecond'))`, [
      callbackId, target.kind, target.action, target.entityId, target.reportDate, this.#callbackTtlMs,
    ]);
    return callbackId;
  }

  public async readCallback(callbackId: string): Promise<CallbackTarget | null> {
    if (!/^[A-Za-z0-9_-]{8,48}$/u.test(callbackId)) return null;
    const result = await this.#pool.query<Record<string, unknown>>(`SELECT entity_kind, callback_action, entity_id, report_date
      FROM operations.telegram_callback
      WHERE callback_id = $1 AND expires_at > clock_timestamp() LIMIT 1`, [callbackId]);
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      kind: row.entity_kind as CallbackTarget['kind'],
      action: row.callback_action as CallbackTarget['action'],
      entityId: String(row.entity_id),
      reportDate: row.report_date === null ? null : new Date(row.report_date as string | Date).toISOString().slice(0, 10),
    };
  }

  public async recordResourceSample(sample: ResourceSample, sampledAt: Date = new Date(sample.generatedAt)): Promise<boolean> {
    if (Number.isNaN(sampledAt.getTime())) return false;
    const database = measurementValue(sample.databaseBytes);
    const spool = measurementValue(sample.spoolBytes);
    const cpu = measurementValue(preferredMeasurement(sample.hostCpuRatio, sample.telegramProcessCpuRatio));
    const memory = measurementValue(preferredMeasurement(sample.hostMemoryRatio, sample.telegramContainerMemoryRatio));
    const disk = measurementValue(preferredMeasurement(sample.hostDiskFreeRatio, sample.spoolFreeRatio));
    if ([database, spool, cpu, memory, disk].every((value) => value === null)) return false;
    const result = await this.#pool.query<Record<string, unknown>>(`INSERT INTO operations.telegram_resource_sample (
        sampled_at, database_bytes, spool_bytes, cpu_ratio, memory_ratio, disk_free_ratio
      )
      SELECT $1::timestamptz, $2::bigint, $3::bigint, $4::double precision, $5::double precision, $6::double precision
      WHERE NOT EXISTS (
        SELECT 1 FROM operations.telegram_resource_sample
        WHERE sampled_at > $1::timestamptz - interval '1 hour'
      )
      ON CONFLICT DO NOTHING
      RETURNING sampled_at`, [sampledAt.toISOString(), database, spool, cpu, memory, disk]);
    return result.rows.length === 1;
  }

  public async prune(): Promise<void> {
    await this.#pool.query<Record<string, unknown>>('SELECT operations.telegram_prune_state(clock_timestamp())');
  }
}

function deliveryRecord(row: Readonly<Record<string, unknown>> | undefined): DeliveryRecord | null {
  if (row === undefined) return null;
  const rawMessageId = row.telegram_message_id;
  return {
    delivered: row.delivered_at !== null,
    attempts: Number(row.attempt_count ?? 0),
    lastAttemptAt: row.last_attempt_at === null || row.last_attempt_at === undefined ? null : new Date(row.last_attempt_at as string | Date),
    messageId: rawMessageId === null || rawMessageId === undefined ? null : Number(rawMessageId),
    failureClass: typeof row.failure_class === 'string' ? row.failure_class : null,
  };
}
