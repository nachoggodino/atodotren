import type { Pool, PoolClient } from 'pg';

import { applyCancellation, applyStopEvidence, emptyStop } from './reducer.js';
import type { CanonicalEvidence, CanonicalReport, CanonicalStopState, EvidenceStatus } from './types.js';

export const DEFAULT_ALGORITHM_VERSION = 'canonical-v1';

interface JourneyKeyRow {
  feed_version_id: string;
  source_trip_id: string;
  service_date: string;
  start_time: string | null;
}

interface StaticRow {
  network_id: string;
  timezone: string;
  line_id: string;
  branch_id: string;
  direction_id: number | null;
  service_pattern_id: string;
  scheduled_start_seconds: number;
  scheduled_end_seconds: number;
  mapped_stops: string;
  arrival_stops: string;
}

interface StopRow {
  stop_sequence: number;
  stop_id: string;
  station_id: string;
  arrival_seconds: number;
  scheduled_arrival_at: Date;
}

interface EvidenceRow {
  captured_at: Date;
  idempotency_key: string;
  stop_sequence: number | null;
  renfe_arrival_time: string | null;
  renfe_arrival_delay: number | null;
  trip_relationship: string;
  stop_relationship: string;
  source_timestamp: string | null;
  matching_method: string;
  matching_version: string;
  evidence_classification: CanonicalEvidence['classification'];
  start_date_source: 'provided' | 'inferred';
}

export interface EvidenceProvenanceInput {
  readonly capturedAt: Date;
  readonly idempotencyKey: string;
  readonly startDateSource: 'provided' | 'inferred';
  readonly matchingMethod: string;
  readonly matchingVersion: string;
}

export interface JourneyProvenance {
  readonly startDateSource: 'provided' | 'inferred';
  readonly matchingMethod: string;
  readonly matchingVersion: string;
  readonly matchingConfidence: number;
}

interface JourneyRow { id: string; finalized_at: Date | null; repair_version: number; canonical_algorithm_version: string }

export interface CanonicalizeOptions {
  readonly pool: Pool;
  readonly serviceDate?: string;
  readonly limit?: number;
  readonly rebuild?: boolean;
  readonly algorithmVersion?: string;
  readonly repairVersion?: number;
  readonly repairReason?: string;
  readonly onError?: (error: unknown) => void;
}

export interface CloseOptions {
  readonly pool: Pool;
  readonly now?: Date;
  readonly graceSeconds?: number;
  readonly serviceDate?: string;
  readonly limit?: number;
  readonly algorithmVersion?: string;
}

interface MutableReport {
  command: CanonicalReport['command'];
  journeysCreated: number;
  journeysUpdated: number;
  journeysClosed: number;
  journeyStopsMaterialized: number;
  statuses: Record<EvidenceStatus, number>;
  discrepancyCount: number;
  ignoredStaleEvidence: number;
  ignoredDuplicateEvidence: number;
  unresolvedInput: number;
  ambiguousInput: number;
  algorithmVersion: string;
  repairVersion: number;
  durationMs: number;
  errors: Record<string, number>;
}

function createReport(command: CanonicalReport['command'], algorithmVersion: string, repairVersion = 0): MutableReport {
  return {
    command, journeysCreated: 0, journeysUpdated: 0, journeysClosed: 0,
    journeyStopsMaterialized: 0,
    statuses: { pending: 0, reported_only: 0, observed_presence: 0, skipped: 0, canceled: 0, missing_evidence: 0 },
    discrepancyCount: 0, ignoredStaleEvidence: 0, ignoredDuplicateEvidence: 0,
    unresolvedInput: 0, ambiguousInput: 0, algorithmVersion, repairVersion, durationMs: 0, errors: {},
  };
}

function classifyError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === '23503' || code === '23514' || code === 'P0001') return 'lineage_or_constraint';
  if (code === '42P01' || code === '3F000') return 'migration_missing';
  return 'database';
}

function keyText(key: JourneyKeyRow): string {
  return `${key.feed_version_id}\u001f${key.source_trip_id}\u001f${key.service_date}\u001f${key.start_time ?? ''}`;
}

export function selectJourneyProvenance(evidence: readonly EvidenceProvenanceInput[]): JourneyProvenance {
  if (evidence.length === 0) throw new RangeError('Journey provenance requires evidence');
  const matching = [...evidence].sort((left, right) => {
    const strength = Number(right.matchingMethod.includes('exact')) - Number(left.matchingMethod.includes('exact'));
    if (strength !== 0) return strength;
    const captured = right.capturedAt.getTime() - left.capturedAt.getTime();
    if (captured !== 0) return captured;
    return right.idempotencyKey.localeCompare(left.idempotencyKey);
  })[0];
  if (matching === undefined) throw new RangeError('Journey provenance requires evidence');
  return {
    startDateSource: evidence.some((item) => item.startDateSource === 'provided') ? 'provided' : 'inferred',
    matchingMethod: matching.matchingMethod,
    matchingVersion: matching.matchingVersion,
    matchingConfidence: matching.matchingMethod.includes('exact') ? 1 : 0.85,
  };
}

function asEvidence(row: EvidenceRow): CanonicalEvidence {
  return {
    classification: row.evidence_classification,
    stopSequence: row.stop_sequence,
    capturedAt: row.captured_at,
    sourceTimestamp: row.source_timestamp === null ? null : Number(row.source_timestamp),
    idempotencyKey: row.idempotency_key,
    arrivalTime: row.renfe_arrival_time === null ? null : Number(row.renfe_arrival_time),
    arrivalDelay: row.renfe_arrival_delay,
    stopRelationship: row.stop_relationship,
  };
}

async function beginLocked(client: PoolClient, key: JourneyKeyRow): Promise<void> {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [keyText(key)]);
}

async function processKey(
  client: PoolClient,
  key: JourneyKeyRow,
  algorithmVersion: string,
  repairVersion: number,
  repairReason: string | undefined,
  report: MutableReport,
): Promise<void> {
  await beginLocked(client, key);
  try {
    await client.query('SELECT core.ensure_journey_partitions($1::date)', [key.service_date]);
    const staticResult = await client.query<StaticRow>(`
      SELECT version.network_id, network.timezone, route_map.line_id, pattern_map.branch_id,
        trip.direction_id, pattern_map.service_pattern_id,
        min(stop_time.arrival_seconds)::integer AS scheduled_start_seconds,
        max(stop_time.arrival_seconds)::integer AS scheduled_end_seconds,
        count(station_map.station_id)::text AS mapped_stops,
        count(*)::text AS arrival_stops
      FROM gtfs_static.trip AS trip
      JOIN gtfs_static.feed_version AS version ON version.id = trip.feed_version_id
      JOIN core.network AS network ON network.id = version.network_id
      JOIN gtfs_static.route_line_map AS route_map
        ON route_map.feed_version_id = trip.feed_version_id AND route_map.route_id = trip.route_id
      JOIN gtfs_static.trip_pattern_map AS pattern_map
        ON pattern_map.feed_version_id = trip.feed_version_id AND pattern_map.trip_id = trip.trip_id
      JOIN gtfs_static.stop_time AS stop_time
        ON stop_time.feed_version_id = trip.feed_version_id AND stop_time.trip_id = trip.trip_id
       AND stop_time.arrival_seconds IS NOT NULL
      LEFT JOIN gtfs_static.stop_station_map AS station_map
        ON station_map.feed_version_id = stop_time.feed_version_id AND station_map.stop_id = stop_time.stop_id
      WHERE trip.feed_version_id = $1 AND trip.trip_id = $2
      GROUP BY version.network_id, network.timezone, route_map.line_id, pattern_map.branch_id,
        trip.direction_id, pattern_map.service_pattern_id
    `, [key.feed_version_id, key.source_trip_id]);
    const staticRow = staticResult.rows[0];
    if (staticRow === undefined || staticRow.mapped_stops !== staticRow.arrival_stops) {
      report.unresolvedInput += 1;
      await client.query('ROLLBACK');
      return;
    }
    const evidenceResult = await client.query<EvidenceRow>(`
      SELECT captured_at, idempotency_key, stop_sequence, renfe_arrival_time,
        renfe_arrival_delay, trip_relationship, stop_relationship, source_timestamp,
        matching_method, matching_version, evidence_classification, start_date_source
      FROM ingest.stop_evidence
      WHERE feed_version_id = $1 AND source_trip_id = $2 AND service_date = $3::date
        AND start_time IS NOT DISTINCT FROM $4
      ORDER BY captured_at, id
    `, [key.feed_version_id, key.source_trip_id, key.service_date, key.start_time]);
    const firstEvidence = evidenceResult.rows[0];
    const lastEvidence = evidenceResult.rows.at(-1);
    if (firstEvidence === undefined || lastEvidence === undefined) {
      if (repairVersion > 0) {
        report.errors.repair_evidence_unavailable = (report.errors.repair_evidence_unavailable ?? 0) + 1;
      }
      await client.query('ROLLBACK');
      return;
    }
    const provenance = selectJourneyProvenance(evidenceResult.rows.map((row) => ({
      capturedAt: row.captured_at,
      idempotencyKey: row.idempotency_key,
      startDateSource: row.start_date_source,
      matchingMethod: row.matching_method,
      matchingVersion: row.matching_version,
    })));
    const journeyResult = await client.query<JourneyRow>(`
      SELECT id, finalized_at, repair_version, canonical_algorithm_version
      FROM core.journey
      WHERE service_date = $1::date AND network_id = $2 AND feed_version_id = $3
        AND source_trip_id = $4 AND start_time IS NOT DISTINCT FROM $5
      FOR UPDATE
    `, [key.service_date, staticRow.network_id, key.feed_version_id, key.source_trip_id, key.start_time]);
    let journey = journeyResult.rows[0];
    const repairedClosedAt = journey?.finalized_at ?? null;
    if (journey?.finalized_at !== null && journey !== undefined) {
      if (repairVersion === 0) {
        await client.query('ROLLBACK');
        return;
      }
      if (repairVersion <= journey.repair_version || algorithmVersion === journey.canonical_algorithm_version || repairReason === undefined) {
        await client.query('ROLLBACK');
        report.errors.closed_requires_repair = (report.errors.closed_requires_repair ?? 0) + 1;
        return;
      }
      await client.query(`
        UPDATE core.journey SET lifecycle_status = 'open', finalized_at = NULL,
          canonical_algorithm_version = $3, repair_version = $4, repaired_at = clock_timestamp(),
          repair_reason = $5, revision = revision + 1, updated_at = clock_timestamp()
        WHERE service_date = $1::date AND id = $2
      `, [key.service_date, journey.id, algorithmVersion, repairVersion, repairReason]);
      await client.query(`
        UPDATE core.journey_stop SET
          renfe_arrival_at = NULL, renfe_arrival_delay_seconds = NULL,
          derived_delay_seconds = NULL, delay_discrepancy_seconds = NULL,
          selected_delay_seconds = NULL, selected_delay_source = NULL,
          evidence_status = CASE WHEN first_stopped_presence_at IS NULL THEN 'pending' ELSE 'observed_presence' END,
          evidence_first_captured_at = NULL, evidence_selected_captured_at = NULL,
          evidence_selected_source_at = NULL, evidence_selected_idempotency_key = NULL,
          stop_relationship = 'SCHEDULED', finalized_at = NULL,
          canonical_algorithm_version = $3, repair_version = $4, repaired_at = clock_timestamp(),
          revision = revision + 1, updated_at = clock_timestamp()
        WHERE service_date = $1::date AND journey_id = $2
      `, [key.service_date, journey.id, algorithmVersion, repairVersion]);
      journey = { ...journey, finalized_at: null, repair_version: repairVersion, canonical_algorithm_version: algorithmVersion };
    }
    if (journey === undefined) {
      const inserted = await client.query<JourneyRow>(`
        INSERT INTO core.journey (
          service_date, network_id, feed_version_id, source_trip_id, start_time, start_date_source,
          line_id, branch_id, direction, service_pattern_id, scheduled_start_seconds,
          scheduled_end_seconds, scheduled_start_at, scheduled_end_at, trip_relationship,
          matching_method, matching_version, matching_confidence, canonical_algorithm_version,
          first_evidence_at, last_evidence_at
        ) VALUES (
          $1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          core.service_instant($1::date, $11, $13), core.service_instant($1::date, $12, $13),
          $14, $15, $16, $17, $18, $19, $20
        ) RETURNING id, finalized_at, repair_version, canonical_algorithm_version
      `, [
        key.service_date, staticRow.network_id, key.feed_version_id, key.source_trip_id, key.start_time,
        provenance.startDateSource, staticRow.line_id, staticRow.branch_id, staticRow.direction_id,
        staticRow.service_pattern_id, staticRow.scheduled_start_seconds, staticRow.scheduled_end_seconds,
        staticRow.timezone, lastEvidence.trip_relationship, provenance.matchingMethod,
        provenance.matchingVersion, provenance.matchingConfidence,
        algorithmVersion, firstEvidence.captured_at, lastEvidence.captured_at,
      ]);
      journey = inserted.rows[0];
      if (journey === undefined) throw new Error('Journey insert returned no identity');
      report.journeysCreated += 1;
    } else {
      report.journeysUpdated += 1;
    }
    const materialized = await client.query<{ stop_sequence: number }>(`
      INSERT INTO core.journey_stop (
        service_date, journey_id, stop_sequence, station_id, feed_version_id, source_trip_id,
        source_stop_id, scheduled_arrival_seconds, scheduled_arrival_at, matching_method,
        matching_version, canonical_algorithm_version, repair_version, repaired_at
      )
      SELECT $1::date, $2, stop_time.stop_sequence, station_map.station_id,
        stop_time.feed_version_id, stop_time.trip_id, stop_time.stop_id, stop_time.arrival_seconds,
        core.service_instant($1::date, stop_time.arrival_seconds, $5), $6, $7, $8, $9,
        CASE WHEN $9::integer > 0 THEN clock_timestamp() ELSE NULL END
      FROM gtfs_static.stop_time AS stop_time
      JOIN gtfs_static.stop_station_map AS station_map
        ON station_map.feed_version_id = stop_time.feed_version_id AND station_map.stop_id = stop_time.stop_id
      WHERE stop_time.feed_version_id = $3 AND stop_time.trip_id = $4
        AND stop_time.arrival_seconds IS NOT NULL
      ON CONFLICT (service_date, journey_id, stop_sequence) DO NOTHING
      RETURNING stop_sequence
    `, [key.service_date, journey.id, key.feed_version_id, key.source_trip_id, staticRow.timezone,
      provenance.matchingMethod, provenance.matchingVersion, algorithmVersion, repairVersion]);
    report.journeyStopsMaterialized += materialized.rowCount ?? 0;
    const stopResult = await client.query<StopRow>(`
      SELECT stop_sequence, source_stop_id AS stop_id, station_id, scheduled_arrival_seconds AS arrival_seconds,
        scheduled_arrival_at
      FROM core.journey_stop WHERE service_date = $1::date AND journey_id = $2 ORDER BY stop_sequence
    `, [key.service_date, journey.id]);
    const states = new Map<number, CanonicalStopState>(
      stopResult.rows.map((stop) => [stop.stop_sequence, emptyStop(stop.stop_sequence, stop.scheduled_arrival_at)]),
    );
    const counts = { stale: 0, duplicate: 0 };
    let canceled = false;
    for (const row of evidenceResult.rows) {
      const evidence = asEvidence(row);
      if (evidence.classification === 'trip_cancellation') {
        canceled = true;
      } else if (evidence.stopSequence !== null) {
        const state = states.get(evidence.stopSequence);
        if (state === undefined) report.unresolvedInput += 1;
        else applyStopEvidence(state, evidence, counts);
      }
    }
    const lifecycle = canceled ? applyCancellation([...states.values()]) : 'open';
    if (!canceled && repairedClosedAt !== null) {
      for (const state of states.values()) {
        if (state.status === 'pending') state.status = 'missing_evidence';
      }
    }
    report.ignoredStaleEvidence += counts.stale;
    report.ignoredDuplicateEvidence += counts.duplicate;
    for (const state of states.values()) {
      report.statuses[state.status] += 1;
      if (state.discrepancy !== null && state.discrepancy !== 0) report.discrepancyCount += 1;
      await client.query(`
        UPDATE core.journey_stop SET renfe_arrival_at = $4, renfe_arrival_delay_seconds = $5,
          derived_delay_seconds = $6, delay_discrepancy_seconds = $7,
          first_stopped_presence_at = COALESCE(first_stopped_presence_at, $8),
          selected_delay_seconds = $9, selected_delay_source = $10, evidence_status = $11,
          evidence_first_captured_at = $12, evidence_selected_captured_at = $13,
          evidence_selected_source_at = $14, evidence_selected_idempotency_key = $15,
          stop_relationship = $16, canonical_algorithm_version = $17,
          matching_method = $19, matching_version = $20,
          repair_version = GREATEST(repair_version, $18),
          repaired_at = CASE WHEN $18::integer > 0 THEN COALESCE(repaired_at, clock_timestamp()) ELSE repaired_at END,
          updated_at = clock_timestamp()
        WHERE service_date = $1::date AND journey_id = $2 AND stop_sequence = $3
      `, [key.service_date, journey.id, state.stopSequence, state.renfeArrivalAt, state.providedDelay,
        state.derivedDelay, state.discrepancy, state.firstPresenceAt, state.selectedDelay,
        state.selectedDelaySource, state.status, state.firstCapturedAt, state.selectedCapturedAt,
        state.selectedSourceAt, state.selectedIdempotencyKey, state.stopRelationship,
        algorithmVersion, repairVersion, provenance.matchingMethod, provenance.matchingVersion]);
    }
    const finalize = canceled ? lastEvidence.captured_at : repairedClosedAt;
    if (finalize !== null) {
      await client.query(`UPDATE core.journey_stop SET finalized_at = $3
        WHERE service_date = $1::date AND journey_id = $2`, [key.service_date, journey.id, finalize]);
    }
    await client.query(`
      UPDATE core.journey SET trip_relationship = $3, lifecycle_status = $4,
        first_evidence_at = LEAST(first_evidence_at, $5), last_evidence_at = GREATEST(last_evidence_at, $6),
        finalized_at = $7, canonical_algorithm_version = $8,
        start_date_source = $10, matching_method = $11, matching_version = $12,
        matching_confidence = $13,
        repair_version = GREATEST(repair_version, $9),
        repaired_at = CASE WHEN $9::integer > 0 THEN COALESCE(repaired_at, clock_timestamp()) ELSE repaired_at END,
        revision = revision + 1, updated_at = clock_timestamp()
      WHERE service_date = $1::date AND id = $2
    `, [key.service_date, journey.id, lastEvidence.trip_relationship,
      canceled ? lifecycle : (finalize === null ? 'open' : 'closed'), firstEvidence.captured_at, lastEvidence.captured_at,
      finalize, algorithmVersion, repairVersion, provenance.startDateSource,
      provenance.matchingMethod, provenance.matchingVersion, provenance.matchingConfidence]);
    if (finalize !== null) report.journeysClosed += 1;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function canonicalizeJourneys(options: CanonicalizeOptions): Promise<CanonicalReport> {
  const started = performance.now();
  const algorithmVersion = options.algorithmVersion ?? DEFAULT_ALGORITHM_VERSION;
  const repairVersion = options.repairVersion ?? 0;
  const command = repairVersion > 0 ? 'repair-journeys' : 'canonicalize';
  const report = createReport(command, algorithmVersion, repairVersion);
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError('limit must be from 1 through 10000');
  if ((repairVersion > 0) !== (options.repairReason !== undefined)) {
    throw new RangeError('repairVersion and repairReason must be provided together');
  }
  if (repairVersion > 0 && options.serviceDate === undefined) {
    throw new RangeError('repair requires an explicit serviceDate');
  }
  const unresolved = await options.pool.query<{ count: string }>(`
    SELECT count(*)::text FROM ingest.stop_evidence WHERE service_date IS NULL
  `);
  report.unresolvedInput = Number(unresolved.rows[0]?.count ?? 0);
  const keys = repairVersion > 0
    ? await options.pool.query<JourneyKeyRow>(`
        SELECT feed_version_id, source_trip_id, service_date::text, start_time
        FROM core.journey
        WHERE service_date = $1::date AND finalized_at IS NOT NULL
        ORDER BY feed_version_id, source_trip_id, start_time
        LIMIT $2
      `, [options.serviceDate, limit])
    : await options.pool.query<JourneyKeyRow>(`
        SELECT DISTINCT evidence.feed_version_id, evidence.source_trip_id,
          evidence.service_date::text, evidence.start_time
        FROM ingest.stop_evidence AS evidence
        WHERE evidence.service_date IS NOT NULL AND ($1::date IS NULL OR evidence.service_date = $1::date)
          AND ($3::boolean OR NOT EXISTS (
            SELECT 1 FROM core.journey AS journey
            WHERE journey.service_date = evidence.service_date
              AND journey.feed_version_id = evidence.feed_version_id
              AND journey.source_trip_id = evidence.source_trip_id
              AND journey.start_time IS NOT DISTINCT FROM evidence.start_time
          ) OR EXISTS (
            SELECT 1 FROM core.journey AS journey
            WHERE journey.service_date = evidence.service_date
              AND journey.feed_version_id = evidence.feed_version_id
              AND journey.source_trip_id = evidence.source_trip_id
              AND journey.start_time IS NOT DISTINCT FROM evidence.start_time
              AND journey.finalized_at IS NULL AND evidence.captured_at > journey.last_evidence_at
          ))
        ORDER BY service_date, feed_version_id, source_trip_id, start_time
        LIMIT $2
      `, [options.serviceDate ?? null, limit, options.rebuild ?? false]);
  if (repairVersion > 0 && keys.rows.length === 0) {
    report.errors.repair_target_not_found = 1;
  }
  for (const key of keys.rows) {
    const client = await options.pool.connect();
    try {
      await processKey(client, key, algorithmVersion, repairVersion, options.repairReason, report);
    } catch (error) {
      options.onError?.(error);
      const classification = classifyError(error);
      report.errors[classification] = (report.errors[classification] ?? 0) + 1;
    } finally {
      client.release();
    }
  }
  report.durationMs = Math.round(performance.now() - started);
  return report;
}

export async function closeJourneys(options: CloseOptions): Promise<CanonicalReport> {
  const started = performance.now();
  const algorithmVersion = options.algorithmVersion ?? DEFAULT_ALGORITHM_VERSION;
  const report = createReport('close-journeys', algorithmVersion);
  const now = options.now ?? new Date();
  const graceSeconds = options.graceSeconds ?? 7200;
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 0 || graceSeconds > 86_400) {
    throw new RangeError('graceSeconds must be from 0 through 86400');
  }
  const client = await options.pool.connect();
  try {
    await client.query('BEGIN');
    const eligible = await client.query<{ service_date: string; id: string }>(`
      SELECT service_date::text, id FROM core.journey
      WHERE finalized_at IS NULL AND scheduled_end_at + make_interval(secs => $1) <= $2
        AND ($3::date IS NULL OR service_date = $3::date)
      ORDER BY scheduled_end_at, id FOR UPDATE SKIP LOCKED LIMIT $4
    `, [graceSeconds, now, options.serviceDate ?? null, limit]);
    for (const journey of eligible.rows) {
      const changed = await client.query<{ evidence_status: EvidenceStatus }>(`
        UPDATE core.journey_stop SET
          evidence_status = CASE WHEN evidence_status = 'pending' THEN 'missing_evidence' ELSE evidence_status END,
          finalized_at = $3, updated_at = clock_timestamp()
        WHERE service_date = $1::date AND journey_id = $2
        RETURNING evidence_status
      `, [journey.service_date, journey.id, now]);
      for (const row of changed.rows) report.statuses[row.evidence_status] += 1;
      await client.query(`UPDATE core.journey SET lifecycle_status = 'closed', finalized_at = $3,
        revision = revision + 1, updated_at = clock_timestamp()
        WHERE service_date = $1::date AND id = $2`, [journey.service_date, journey.id, now]);
      report.journeysClosed += 1;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    const classification = classifyError(error);
    report.errors[classification] = (report.errors[classification] ?? 0) + 1;
  } finally {
    client.release();
  }
  report.durationMs = Math.round(performance.now() - started);
  return report;
}
