import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Pool } from 'pg';

import { persistBatch, type PersistenceResult } from './persistence.js';
import type { NormalizedBatch, PollRecord } from './types.js';

const maximumConfiguredBytes = 10 * 1024 * 1024 * 1024;
const defaultBacklogMs = 48 * 60 * 60 * 1_000;

export interface SpoolEnvelope {
  readonly poll: PollRecord;
  readonly batch?: NormalizedBatch;
}

export interface SpoolStats {
  readonly pendingCount: number;
  readonly pendingOperations: number;
  readonly sizeBytes: number;
  readonly droppedCount: number;
  readonly droppedByReason: Readonly<Record<string, number>>;
}

export interface EnqueueResult {
  readonly stored: boolean;
  readonly duplicate: boolean;
  readonly droppedVehiclePositions: number;
  readonly droppedOther: number;
}

interface QueueRow {
  readonly sequence: number;
  readonly payload: string;
}

interface CountRow { readonly value: number; }
interface DropRow { readonly reason: string; readonly value: number; }

export class OutageSpool {
  readonly #database: DatabaseSync;
  readonly #path: string;
  readonly #maxBytes: number;
  readonly #maxBacklogMs: number;

  public constructor(path: string, maxBytes: number, maxBacklogMs = defaultBacklogMs) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > maximumConfiguredBytes) {
      throw new Error('SQLite spool maximum must be a positive integer no greater than 10 GiB');
    }
    if (!Number.isSafeInteger(maxBacklogMs) || maxBacklogMs <= 0 || maxBacklogMs > defaultBacklogMs) {
      throw new Error('SQLite spool logical backlog cannot exceed 48 hours');
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#path = path;
    this.#maxBytes = maxBytes;
    this.#maxBacklogMs = maxBacklogMs;
    this.#database = new DatabaseSync(path, { timeout: 5_000, enableForeignKeyConstraints: true });
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS pending_operation (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        captured_at_ms INTEGER NOT NULL,
        enqueued_at_ms INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        operation_count INTEGER NOT NULL,
        vehicle_count INTEGER NOT NULL,
        logical_bytes INTEGER NOT NULL,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS pending_operation_order_idx ON pending_operation(sequence);
      CREATE INDEX IF NOT EXISTS pending_operation_age_idx ON pending_operation(captured_at_ms);
      CREATE TABLE IF NOT EXISTS dropped_operation (
        reason TEXT PRIMARY KEY,
        dropped_count INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    this.purgeExpired(Date.now());
  }

  public close(): void {
    this.#database.close();
  }

  public get capacityBytes(): number {
    return this.#maxBytes;
  }

  public sizeBytes(): number {
    return [this.#path, `${this.#path}-wal`, `${this.#path}-shm`]
      .reduce((total, path) => total + (existsSync(path) ? statSync(path).size : 0), 0);
  }

  #recordDrop(reason: string, count: number): void {
    if (count <= 0) return;
    this.#database.prepare(`
      INSERT INTO dropped_operation (reason, dropped_count, updated_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT (reason) DO UPDATE SET
        dropped_count = dropped_operation.dropped_count + excluded.dropped_count,
        updated_at_ms = excluded.updated_at_ms
    `).run(reason, count, Date.now());
  }

  public purgeExpired(nowMs = Date.now()): number {
    const cutoff = nowMs - this.#maxBacklogMs;
    const row = this.#database.prepare(
      'SELECT COALESCE(sum(operation_count), 0) AS value FROM pending_operation WHERE captured_at_ms < ?',
    ).get(cutoff) as unknown as CountRow;
    const count = Number(row.value);
    if (count > 0) {
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        this.#database.prepare('DELETE FROM pending_operation WHERE captured_at_ms < ?').run(cutoff);
        this.#recordDrop('backlog_expired', count);
        this.#database.exec('COMMIT');
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
    }
    return count;
  }

  #removeQueuedVehicleOnly(requiredBytes: number): number {
    let dropped = 0;
    while (this.sizeBytes() + requiredBytes > this.#maxBytes) {
      const row = this.#database.prepare(`
        SELECT sequence, vehicle_count AS value FROM pending_operation
        WHERE vehicle_count = operation_count - 1 AND vehicle_count > 0
        ORDER BY sequence LIMIT 1
      `).get() as unknown as ({ sequence: number } & CountRow) | undefined;
      if (row === undefined) break;
      this.#database.prepare('DELETE FROM pending_operation WHERE sequence = ?').run(row.sequence);
      this.#database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      dropped += Number(row.value);
    }
    if (dropped > 0) {
      this.#database.exec('VACUUM');
      this.#database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
    return dropped;
  }

  public enqueue(envelope: SpoolEnvelope): EnqueueResult {
    this.purgeExpired(Date.now());
    const duplicate = this.#database.prepare(
      'SELECT 1 AS value FROM pending_operation WHERE idempotency_key = ?',
    ).get(envelope.poll.idempotencyKey);
    if (duplicate !== undefined) {
      return { stored: true, duplicate: true, droppedVehiclePositions: 0, droppedOther: 0 };
    }

    let droppedVehiclePositions = 0;
    let filteredBatch = envelope.batch;
    let payload = JSON.stringify(envelope);
    let payloadBytes = Buffer.byteLength(payload);
    if (this.sizeBytes() + payloadBytes + 4_096 > this.#maxBytes && filteredBatch !== undefined) {
      const retained = filteredBatch.operations.filter((operation) => operation.kind !== 'vehicle_state');
      droppedVehiclePositions = filteredBatch.operations.length - retained.length;
      filteredBatch = { ...filteredBatch, operations: retained, filteredEntities: [] };
      payload = JSON.stringify({ poll: envelope.poll, batch: filteredBatch });
      payloadBytes = Buffer.byteLength(payload);
    }
    droppedVehiclePositions += this.#removeQueuedVehicleOnly(payloadBytes + 4_096);
    if (this.sizeBytes() + payloadBytes + 4_096 > this.#maxBytes) {
      const droppedOther = filteredBatch?.operations.length ?? 0;
      this.#recordDrop('capacity_hard_limit', droppedOther + 1);
      this.#recordDrop('capacity_vehicle_shed', droppedVehiclePositions);
      return { stored: false, duplicate: false, droppedVehiclePositions, droppedOther: droppedOther + 1 };
    }
    this.#recordDrop('capacity_vehicle_shed', droppedVehiclePositions);
    const operations = filteredBatch?.operations.length ?? 0;
    const vehicleCount = filteredBatch?.operations.filter((operation) => operation.kind === 'vehicle_state').length ?? 0;
    const priority = filteredBatch?.operations.some((operation) =>
      operation.kind === 'stop_evidence' || operation.kind === 'service_alert') === true ? 0
      : vehicleCount > 0 ? 2 : 1;
    this.#database.prepare(`
      INSERT INTO pending_operation (
        idempotency_key, captured_at_ms, enqueued_at_ms, priority,
        operation_count, vehicle_count, logical_bytes, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(envelope.poll.idempotencyKey, Date.parse(envelope.poll.capturedAt), Date.now(),
      priority, operations + 1, vehicleCount, payloadBytes, payload);
    this.#database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    if (this.sizeBytes() > this.#maxBytes) {
      this.#database.prepare('DELETE FROM pending_operation WHERE idempotency_key = ?').run(envelope.poll.idempotencyKey);
      this.#database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      this.#recordDrop('capacity_hard_limit', operations + 1);
      return { stored: false, duplicate: false, droppedVehiclePositions, droppedOther: operations + 1 };
    }
    return { stored: true, duplicate: false, droppedVehiclePositions, droppedOther: 0 };
  }

  public peek(): { readonly sequence: number; readonly envelope: SpoolEnvelope } | undefined {
    const row = this.#database.prepare(
      'SELECT sequence, payload FROM pending_operation ORDER BY sequence LIMIT 1',
    ).get() as unknown as QueueRow | undefined;
    if (row === undefined) return undefined;
    return { sequence: Number(row.sequence), envelope: JSON.parse(row.payload) as SpoolEnvelope };
  }

  public acknowledge(sequence: number): void {
    this.#database.prepare('DELETE FROM pending_operation WHERE sequence = ?').run(sequence);
    this.#database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  public stats(): SpoolStats {
    const pending = this.#database.prepare(`
      SELECT count(*) AS pending_count, COALESCE(sum(operation_count), 0) AS operation_count
      FROM pending_operation
    `).get() as unknown as { pending_count: number; operation_count: number };
    const rows = this.#database.prepare(
      'SELECT reason, dropped_count AS value FROM dropped_operation ORDER BY reason',
    ).all() as unknown as DropRow[];
    const droppedByReason = Object.fromEntries(rows.map((row) => [row.reason, Number(row.value)]));
    return {
      pendingCount: Number(pending.pending_count), pendingOperations: Number(pending.operation_count),
      sizeBytes: this.sizeBytes(),
      droppedCount: Object.values(droppedByReason).reduce((total, value) => total + value, 0),
      droppedByReason,
    };
  }
}

export async function replaySpool(
  spool: OutageSpool,
  pool: Pool,
  maximumItems = Number.POSITIVE_INFINITY,
): Promise<{ readonly replayed: number; readonly lastResult?: PersistenceResult }> {
  let replayed = 0;
  let lastResult: PersistenceResult | undefined;
  while (replayed < maximumItems) {
    const next = spool.peek();
    if (next === undefined) break;
    lastResult = await persistBatch(pool, next.envelope.poll, next.envelope.batch);
    spool.acknowledge(next.sequence);
    replayed += 1;
  }
  return { replayed, ...(lastResult === undefined ? {} : { lastResult }) };
}
