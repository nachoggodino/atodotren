import { gzipSync } from 'node:zlib';

import type { Pool, PoolClient, QueryResult } from 'pg';

import { checksum, FILTERED_PAYLOAD_CODEC } from './normalize.js';
import type {
  NormalizedBatch,
  PendingOperation,
  PollRecord,
  ServiceAlertOperation,
  StopEvidenceOperation,
  VehicleStateOperation,
} from './types.js';

export interface PersistenceResult {
  readonly evidenceInserted: number;
  readonly evidenceRepeated: number;
  readonly vehiclesUpserted: number;
  readonly alertsChanged: number;
  readonly quarantined: number;
}

function captureDate(value: string): string {
  return value.slice(0, 10);
}

async function insertEvidence(client: PoolClient, operation: StopEvidenceOperation): Promise<boolean> {
  const state = await client.query(`
    INSERT INTO ingest.evidence_state (
      evidence_key, evidence_checksum, last_idempotency_key, updated_at
    ) VALUES ($1, $2, $3, $4)
    ON CONFLICT (evidence_key) DO UPDATE SET
      evidence_checksum = EXCLUDED.evidence_checksum,
      last_idempotency_key = EXCLUDED.last_idempotency_key,
      updated_at = EXCLUDED.updated_at
    WHERE ingest.evidence_state.evidence_checksum IS DISTINCT FROM EXCLUDED.evidence_checksum
      AND ingest.evidence_state.updated_at <= EXCLUDED.updated_at
    RETURNING evidence_key
  `, [operation.evidenceKey, operation.evidenceChecksum, operation.idempotencyKey, operation.capturedAt]);
  if (state.rowCount === 0) return false;
  await client.query(`
    INSERT INTO ingest.stop_evidence (
      captured_at, idempotency_key, evidence_key, evidence_checksum, feed_kind,
      feed_version_id, source_trip_id, service_date, start_time, start_date_source,
      stop_id, stop_sequence, station_id, renfe_arrival_time, renfe_arrival_delay,
      trip_relationship, stop_relationship, source_timestamp,
      matching_method, matching_version, evidence_classification
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
    ) ON CONFLICT (captured_at, idempotency_key) DO NOTHING
  `, [
    operation.capturedAt, operation.idempotencyKey, operation.evidenceKey, operation.evidenceChecksum,
    operation.feedKind, operation.feedVersionId, operation.sourceTripId, operation.serviceDate ?? null,
    operation.startTime ?? null, operation.startDateSource, operation.stopId ?? null,
    operation.stopSequence ?? null, operation.stationId ?? null, operation.arrivalTime ?? null,
    operation.arrivalDelay ?? null, operation.tripRelationship, operation.stopRelationship,
    operation.sourceTimestamp ?? null, operation.matchingMethod, operation.matchingVersion,
    operation.classification,
  ]);
  return true;
}

async function upsertVehicle(client: PoolClient, operation: VehicleStateOperation): Promise<boolean> {
  const result = await client.query(`
    INSERT INTO ingest.live_vehicle_state (
      state_key, feed_version_id, source_trip_id, service_date, start_time,
      line_id, branch_id, service_pattern_id, vehicle_id, entity_id,
      latitude, longitude, bearing, speed, current_stop_sequence, current_stop_id,
      current_station_id, current_status, latest_stop_delay, vehicle_timestamp,
      feed_header_timestamp, captured_at, shape_id, projection_input,
      projection_confidence, content_checksum
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25, $26
    )
    ON CONFLICT (state_key) DO UPDATE SET
      feed_version_id = EXCLUDED.feed_version_id,
      source_trip_id = EXCLUDED.source_trip_id,
      service_date = EXCLUDED.service_date,
      start_time = EXCLUDED.start_time,
      line_id = EXCLUDED.line_id,
      branch_id = EXCLUDED.branch_id,
      service_pattern_id = EXCLUDED.service_pattern_id,
      vehicle_id = EXCLUDED.vehicle_id,
      entity_id = EXCLUDED.entity_id,
      latitude = EXCLUDED.latitude,
      longitude = EXCLUDED.longitude,
      bearing = EXCLUDED.bearing,
      speed = EXCLUDED.speed,
      current_stop_sequence = EXCLUDED.current_stop_sequence,
      current_stop_id = EXCLUDED.current_stop_id,
      current_station_id = EXCLUDED.current_station_id,
      current_status = EXCLUDED.current_status,
      latest_stop_delay = COALESCE(EXCLUDED.latest_stop_delay, ingest.live_vehicle_state.latest_stop_delay),
      vehicle_timestamp = EXCLUDED.vehicle_timestamp,
      feed_header_timestamp = EXCLUDED.feed_header_timestamp,
      captured_at = EXCLUDED.captured_at,
      shape_id = EXCLUDED.shape_id,
      projection_input = EXCLUDED.projection_input,
      projection_confidence = EXCLUDED.projection_confidence,
      content_checksum = EXCLUDED.content_checksum
    WHERE EXCLUDED.captured_at >= ingest.live_vehicle_state.captured_at
    RETURNING state_key
  `, [
    operation.stateKey, operation.feedVersionId, operation.sourceTripId, operation.serviceDate ?? null,
    operation.startTime ?? null, operation.lineId, operation.branchId, operation.servicePatternId,
    operation.vehicleId ?? null, operation.entityId, operation.latitude ?? null, operation.longitude ?? null,
    operation.bearing ?? null, operation.speed ?? null, operation.currentStopSequence ?? null,
    operation.currentStopId ?? null, operation.currentStationId ?? null, operation.currentStatus,
    operation.latestStopDelay ?? null, operation.vehicleTimestamp ?? null, operation.feedHeaderTimestamp,
    operation.capturedAt, operation.shapeId ?? null, operation.projectionInput,
    operation.projectionConfidence ?? null, operation.contentChecksum,
  ]);
  return result.rowCount === 1;
}

async function upsertAlert(client: PoolClient, operation: ServiceAlertOperation): Promise<boolean> {
  const changed = await client.query(`
    INSERT INTO ingest.service_alert (
      source_alert_id, feed_header_timestamp, captured_at, active_periods,
      cause, effect, header_text, description_text, url, content_checksum, is_active
    ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, true)
    ON CONFLICT (source_alert_id) DO UPDATE SET
      feed_header_timestamp = EXCLUDED.feed_header_timestamp,
      captured_at = EXCLUDED.captured_at,
      active_periods = EXCLUDED.active_periods,
      cause = EXCLUDED.cause,
      effect = EXCLUDED.effect,
      header_text = EXCLUDED.header_text,
      description_text = EXCLUDED.description_text,
      url = EXCLUDED.url,
      content_checksum = EXCLUDED.content_checksum,
      is_active = true,
      updated_at = clock_timestamp()
    WHERE EXCLUDED.captured_at >= ingest.service_alert.captured_at
      AND ingest.service_alert.content_checksum IS DISTINCT FROM EXCLUDED.content_checksum
    RETURNING source_alert_id
  `, [
    operation.sourceAlertId, operation.feedHeaderTimestamp, operation.capturedAt,
    JSON.stringify(operation.activePeriods), operation.cause, operation.effect,
    operation.headerText, operation.descriptionText, operation.url ?? null, operation.contentChecksum,
  ]);
  if (changed.rowCount === 0) return false;
  await client.query('DELETE FROM ingest.service_alert_target WHERE source_alert_id = $1', [operation.sourceAlertId]);
  for (const target of operation.targets) {
    await client.query(`
      INSERT INTO ingest.service_alert_target (
        source_alert_id, target_order, feed_version_id, route_id, line_id,
        stop_id, station_id, trip_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [operation.sourceAlertId, target.order, target.feedVersionId ?? null, target.routeId ?? null,
      target.lineId ?? null, target.stopId ?? null, target.stationId ?? null, target.tripId ?? null]);
  }
  return true;
}

async function persistOperation(client: PoolClient, operation: PendingOperation): Promise<'evidence' | 'repeat' | 'vehicle' | 'alert' | 'quarantine'> {
  if (operation.kind === 'stop_evidence') return await insertEvidence(client, operation) ? 'evidence' : 'repeat';
  if (operation.kind === 'vehicle_state') {
    await upsertVehicle(client, operation);
    return 'vehicle';
  }
  if (operation.kind === 'service_alert') {
    await upsertAlert(client, operation);
    return 'alert';
  }
  await client.query(`
    INSERT INTO ingest.quarantined_entity (
      captured_at, idempotency_key, feed_kind, feed_header_timestamp,
      entity_id, trip_id, route_id, stop_id, reason_code, diagnostic_fields
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
    ON CONFLICT (captured_at, idempotency_key) DO NOTHING
  `, [operation.capturedAt, operation.idempotencyKey, operation.feedKind,
    operation.feedHeaderTimestamp ?? null, operation.entityId ?? null, operation.tripId ?? null,
    operation.routeId ?? null, operation.stopId ?? null, operation.reasonCode,
    JSON.stringify(operation.diagnosticFields)]);
  return 'quarantine';
}

async function insertPoll(
  client: PoolClient,
  poll: PollRecord,
  evidenceChanged: number,
  evidenceRepeated: number,
): Promise<void> {
  await client.query(`
    INSERT INTO ingest.poll_run (
      captured_at, idempotency_key, feed_kind, started_at, completed_at,
      feed_header_timestamp, http_status, result_class, response_bytes, entity_total,
      matched_madrid_count, non_madrid_count, unmatched_count, invalid_count,
      evidence_changed_count, evidence_repeated_count,
      response_duration_ms, persistence_duration_ms, error_code
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19
    ) ON CONFLICT (captured_at, idempotency_key) DO NOTHING
  `, [poll.capturedAt, poll.idempotencyKey, poll.feedKind, poll.startedAt, poll.completedAt,
    poll.feedHeaderTimestamp ?? null, poll.httpStatus ?? null, poll.resultClass,
    poll.responseBytes, poll.entityTotal, poll.matchedMadridCount, poll.nonMadridCount,
    poll.unmatchedCount, poll.invalidCount, evidenceChanged, evidenceRepeated,
    poll.responseDurationMs, poll.persistenceDurationMs, poll.errorCode ?? null]);
}

async function insertFilteredPayload(client: PoolClient, batch: NormalizedBatch): Promise<void> {
  if (batch.filteredEntities.length === 0) return;
  const plain = Buffer.from(JSON.stringify({
    version: 1, feedKind: batch.feedKind, headerTimestamp: batch.headerTimestamp,
    entities: batch.filteredEntities,
  }));
  const compressed = gzipSync(plain, { level: 6 });
  const contentChecksum = checksum(plain.toString('utf8'));
  const idempotencyKey = checksum([batch.feedKind, batch.capturedAt, contentChecksum]);
  await client.query(`
    INSERT INTO ingest.filtered_payload (
      captured_at, idempotency_key, feed_kind, feed_header_timestamp,
      content_checksum, codec_version, compressed_payload, uncompressed_bytes, entity_count
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (captured_at, idempotency_key) DO NOTHING
  `, [batch.capturedAt, idempotencyKey, batch.feedKind, batch.headerTimestamp,
    contentChecksum, FILTERED_PAYLOAD_CODEC, compressed, plain.byteLength, batch.filteredEntities.length]);
}

export async function persistBatch(
  pool: Pool,
  poll: PollRecord,
  batch?: NormalizedBatch,
): Promise<PersistenceResult> {
  const persistenceStarted = performance.now();
  const client = await pool.connect();
  const counts = { evidenceInserted: 0, evidenceRepeated: 0, vehiclesUpserted: 0, alertsChanged: 0, quarantined: 0 };
  try {
    await client.query('BEGIN');
    await client.query('SELECT ingest.ensure_realtime_partitions($1::date)', [captureDate(poll.capturedAt)]);
    if (batch !== undefined) {
      await insertFilteredPayload(client, batch);
      for (const operation of batch.operations) {
        const result = await persistOperation(client, operation);
        if (result === 'evidence') counts.evidenceInserted += 1;
        else if (result === 'repeat') counts.evidenceRepeated += 1;
        else if (result === 'vehicle') counts.vehiclesUpserted += 1;
        else if (result === 'alert') counts.alertsChanged += 1;
        else counts.quarantined += 1;
      }
    }
    await insertPoll(client, {
      ...poll,
      persistenceDurationMs: Math.max(poll.persistenceDurationMs, Math.round(performance.now() - persistenceStarted)),
    }, counts.evidenceInserted, counts.evidenceRepeated);
    await client.query('COMMIT');
    return counts;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateIngestHealth(
  pool: Pool,
  values: {
    readonly durableAt?: string;
    readonly postgresAt?: string;
    readonly heartbeatAt?: string;
    readonly consecutiveFailures: number;
    readonly failureCode?: string;
    readonly spoolPendingCount: number;
    readonly spoolBytes: number;
    readonly spoolDroppedCount: number;
  },
): Promise<QueryResult> {
  return pool.query(`
    UPDATE operations.ingest_health SET
      last_durable_cycle_at = COALESCE($1, last_durable_cycle_at),
      last_postgres_cycle_at = COALESCE($2, last_postgres_cycle_at),
      last_heartbeat_at = COALESCE($3, last_heartbeat_at),
      consecutive_failures = $4,
      last_failure_code = $5,
      spool_pending_count = $6,
      spool_bytes = $7,
      spool_dropped_count = $8,
      updated_at = clock_timestamp()
    WHERE singleton
  `, [values.durableAt ?? null, values.postgresAt ?? null, values.heartbeatAt ?? null,
    values.consecutiveFailures, values.failureCode ?? null, values.spoolPendingCount,
    values.spoolBytes, values.spoolDroppedCount]);
}
