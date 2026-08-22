import type { DatabaseConnection } from '@atodotren/db';

type Pool = DatabaseConnection['pool'];
type JsonReport = Readonly<Record<string, unknown>>;

export const DEFAULT_AGGREGATE_ALGORITHM_VERSION = 'aggregate-v1';
export const RETENTION_CONFIRMATION = 'DROP-VERIFIED-PARTITIONS';

const algorithmPattern = /^[a-z0-9_.-]{1,40}$/u;
const serviceDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const monthPattern = /^\d{4}-\d{2}-01$/u;

export type RetentionMode = 'none' | 'plan' | 'authorize' | 'apply';

export interface AggregateOptions {
  readonly pool: Pool;
  readonly serviceDate?: string;
  readonly limit?: number;
  readonly algorithmVersion?: string;
}

export interface AggregateReport {
  readonly command: 'aggregate';
  readonly algorithmVersion: string;
  readonly scopesAttempted: number;
  readonly succeeded: number;
  readonly noops: number;
  readonly failed: number;
  readonly results: readonly JsonReport[];
  readonly errors: readonly string[];
  readonly durationMs: number;
}

export interface RetentionCandidate {
  readonly family: string;
  readonly targetDate: string;
  readonly partitionNames: readonly string[];
  readonly expired: boolean;
  readonly authorized: boolean;
  readonly blockers: readonly string[];
  readonly sourceRows: number;
  readonly sourceChecksum: string;
}

export interface FinalizeOptions {
  readonly pool: Pool;
  readonly serviceDate?: string;
  readonly month?: string;
  readonly limit?: number;
  readonly algorithmVersion?: string;
  readonly now?: Date;
  readonly graceSeconds?: number;
  readonly monthGraceHours?: number;
  readonly acknowledgeIncomplete?: string;
  readonly retentionMode?: RetentionMode;
  readonly liveStateGraceSeconds?: number;
}

export interface FinalizeReport {
  readonly command: 'finalize';
  readonly algorithmVersion: string;
  readonly checkedAt: string;
  readonly serviceDays: readonly JsonReport[];
  readonly months: readonly JsonReport[];
  readonly operationsSummaries: readonly JsonReport[];
  readonly retention: {
    readonly mode: RetentionMode;
    readonly candidates: readonly RetentionCandidate[];
    readonly authorizations: readonly JsonReport[];
    readonly drops: readonly JsonReport[];
    readonly liveState: JsonReport | null;
  };
  readonly errors: readonly string[];
  readonly durationMs: number;
}

interface DirtyRow {
  readonly service_date: string;
}

interface MonthRow {
  readonly calendar_month: string;
}

interface CandidateRow {
  readonly family: string;
  readonly target_date: string;
  readonly partition_names: string[];
  readonly expired: boolean;
  readonly authorized: boolean;
  readonly blockers: string[];
  readonly source_rows: string | number;
  readonly source_checksum: string;
}

function validateAlgorithmVersion(value: string): void {
  if (!algorithmPattern.test(value)) throw new RangeError('Invalid aggregate algorithm version');
}

function validateServiceDate(value: string | undefined): void {
  if (value !== undefined && !serviceDatePattern.test(value)) {
    throw new RangeError('serviceDate must use YYYY-MM-DD');
  }
}

function validateMonth(value: string | undefined): void {
  if (value !== undefined && !monthPattern.test(value)) {
    throw new RangeError('month must be the first day of a calendar month (YYYY-MM-01)');
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return result;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonValue(value: unknown): JsonReport {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonReport
    : { value };
}

function reportStatus(report: JsonReport): string {
  return typeof report.status === 'string' ? report.status : 'unknown';
}

async function selectDirtyDates(pool: Pool, serviceDate: string | undefined, limit: number): Promise<string[]> {
  if (serviceDate !== undefined) return [serviceDate];
  const result = await pool.query<DirtyRow>(`
    SELECT service_date::text
    FROM analytics.dirty_scope
    WHERE family = 'daily'
    ORDER BY dirty_since, service_date
    LIMIT $1
  `, [limit]);
  return result.rows.map((row) => row.service_date);
}

export async function aggregateDirty(options: AggregateOptions): Promise<AggregateReport> {
  const started = performance.now();
  const algorithmVersion = options.algorithmVersion ?? DEFAULT_AGGREGATE_ALGORITHM_VERSION;
  validateAlgorithmVersion(algorithmVersion);
  validateServiceDate(options.serviceDate);
  const limit = boundedInteger(options.limit, 20, 1, 500, 'limit');
  const dates = await selectDirtyDates(options.pool, options.serviceDate, limit);
  const results: JsonReport[] = [];
  const errors: string[] = [];
  let succeeded = 0;
  let noops = 0;

  for (const serviceDate of dates) {
    try {
      const result = await options.pool.query<{ report: unknown }>(
        'SELECT analytics.recompute_daily($1::date, $2::text) AS report',
        [serviceDate, algorithmVersion],
      );
      const report = jsonValue(result.rows[0]?.report);
      results.push(report);
      const status = reportStatus(report);
      if (status === 'noop') noops += 1;
      else if (status === 'succeeded') succeeded += 1;
      else errors.push(`${serviceDate}: aggregation ${status}`);
    } catch (error) {
      errors.push(`${serviceDate}: ${message(error)}`);
    }
  }

  return {
    command: 'aggregate',
    algorithmVersion,
    scopesAttempted: dates.length,
    succeeded,
    noops,
    failed: errors.length,
    results,
    errors,
    durationMs: Math.round(performance.now() - started),
  };
}

export async function selectFinalizeDates(
  pool: Pool,
  serviceDate: string | undefined,
  algorithmVersion: string,
  now: Date,
  limit: number,
): Promise<string[]> {
  if (serviceDate !== undefined) return [serviceDate];
  const result = await pool.query<DirtyRow>(`
    SELECT DISTINCT expected.service_date::text AS service_date
    FROM operations.timetable_service_dates(
      (($2::timestamptz AT TIME ZONE 'Europe/Madrid')::date - 35),
      (($2::timestamptz AT TIME ZONE 'Europe/Madrid')::date - 1)
    ) AS expected
    WHERE NOT EXISTS (
        SELECT 1 FROM operations.service_day_finalization AS finalization
        WHERE finalization.service_date = expected.service_date
          AND finalization.aggregate_algorithm_version = $1
          AND finalization.status = 'verified'
    )
    ORDER BY service_date
    LIMIT $3
  `, [algorithmVersion, now, limit]);
  return result.rows.map((row) => row.service_date);
}

async function selectMonths(
  pool: Pool,
  explicitMonth: string | undefined,
  algorithmVersion: string,
  now: Date,
  limit: number,
): Promise<string[]> {
  if (explicitMonth !== undefined) return [explicitMonth];
  const result = await pool.query<MonthRow>(`
    SELECT DISTINCT date_trunc('month', finalization.service_date)::date::text AS calendar_month
    FROM operations.service_day_finalization AS finalization
    WHERE finalization.status = 'verified'
      AND finalization.aggregate_algorithm_version = $1
      AND date_trunc('month', finalization.service_date) + interval '1 month' <= $2::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM operations.month_seal AS seal
        WHERE seal.calendar_month = date_trunc('month', finalization.service_date)::date
          AND seal.aggregate_algorithm_version = $1
          AND seal.status = 'sealed'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM operations.timetable_service_dates(
          date_trunc('month', finalization.service_date)::date,
          (date_trunc('month', finalization.service_date) + interval '1 month - 1 day')::date
        ) AS expected
        WHERE NOT EXISTS (
          SELECT 1 FROM operations.service_day_finalization AS expected_finalization
          WHERE expected_finalization.service_date = expected.service_date
            AND expected_finalization.aggregate_algorithm_version = $1
            AND expected_finalization.status = 'verified'
        )
      )
    ORDER BY calendar_month
    LIMIT $3
  `, [algorithmVersion, now, limit]);
  return result.rows.map((row) => row.calendar_month);
}

async function retentionCandidates(pool: Pool, now: Date, algorithmVersion: string, limit: number): Promise<RetentionCandidate[]> {
  const result = await pool.query<CandidateRow>(`
    SELECT family, target_date::text, partition_names, expired, authorized, blockers,
      source_rows, source_checksum
    FROM operations.retention_candidates($1::timestamptz, $2::text)
    WHERE expired
    ORDER BY target_date, family
    LIMIT $3
  `, [now, algorithmVersion, limit]);
  return result.rows.map((row) => ({
    family: row.family,
    targetDate: row.target_date,
    partitionNames: row.partition_names,
    expired: row.expired,
    authorized: row.authorized,
    blockers: row.blockers,
    sourceRows: Number(row.source_rows),
    sourceChecksum: row.source_checksum,
  }));
}

function blockersWithoutAuthorization(candidate: RetentionCandidate): string[] {
  return candidate.blockers.filter((blocker) => blocker !== 'authorization_missing');
}

async function summarizeRetentionOperations(
  pool: Pool,
  candidates: readonly RetentionCandidate[],
): Promise<JsonReport[]> {
  const dates = [...new Set(candidates
    .filter((candidate) => candidate.family === 'poll_run' || candidate.family === 'quarantined_entity')
    .map((candidate) => candidate.targetDate))];
  const results: JsonReport[] = [];
  for (const date of dates) {
    const result = await pool.query<{ report: unknown }>(
      'SELECT operations.summarize_operations_date($1::date) AS report',
      [date],
    );
    results.push(jsonValue(result.rows[0]?.report));
  }
  return results;
}

export async function finalizeAnalytics(options: FinalizeOptions): Promise<FinalizeReport> {
  const started = performance.now();
  const algorithmVersion = options.algorithmVersion ?? DEFAULT_AGGREGATE_ALGORITHM_VERSION;
  validateAlgorithmVersion(algorithmVersion);
  validateServiceDate(options.serviceDate);
  validateMonth(options.month);
  const limit = boundedInteger(options.limit, 20, 1, 200, 'limit');
  const graceSeconds = boundedInteger(options.graceSeconds, 7_200, 0, 86_400, 'graceSeconds');
  const monthGraceHours = boundedInteger(options.monthGraceHours, 48, 0, 168, 'monthGraceHours');
  const liveStateGraceSeconds = boundedInteger(options.liveStateGraceSeconds, 7_200, 0, 86_400, 'liveStateGraceSeconds');
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new RangeError('now must be a valid date');
  const retentionMode = options.retentionMode ?? 'none';
  const acknowledgement = options.acknowledgeIncomplete?.trim();
  if (acknowledgement !== undefined && (acknowledgement.length < 1 || acknowledgement.length > 200)) {
    throw new RangeError('acknowledgeIncomplete must contain 1 through 200 characters');
  }
  if (acknowledgement !== undefined && options.serviceDate === undefined) {
    throw new RangeError('acknowledgeIncomplete requires an explicit serviceDate');
  }
  const serviceDays: JsonReport[] = [];
  const months: JsonReport[] = [];
  const operationsSummaries: JsonReport[] = [];
  const authorizations: JsonReport[] = [];
  const drops: JsonReport[] = [];
  const errors: string[] = [];

  const finalizeDates = await selectFinalizeDates(options.pool, options.serviceDate, algorithmVersion, now, limit);
  for (const serviceDate of finalizeDates) {
    try {
      if (acknowledgement !== undefined) {
        const acknowledged = await options.pool.query<{ report: unknown }>(
          'SELECT operations.acknowledge_incomplete_service_day($1::date, $2::text) AS report',
          [serviceDate, acknowledgement],
        );
        operationsSummaries.push(jsonValue(acknowledged.rows[0]?.report));
      }
      await options.pool.query(
        'SELECT operations.materialize_expected_service_day($1::date, $2::text, $3::timestamptz, $4::integer)',
        [serviceDate, algorithmVersion, now, graceSeconds],
      );
      await options.pool.query(
        'SELECT analytics.recompute_daily($1::date, $2::text)',
        [serviceDate, algorithmVersion],
      );
      const summary = await options.pool.query<{ report: unknown }>(
        'SELECT operations.summarize_operations_date($1::date) AS report',
        [serviceDate],
      );
      operationsSummaries.push(jsonValue(summary.rows[0]?.report));
      const result = await options.pool.query<{ report: unknown }>(
        'SELECT operations.finalize_service_day($1::date, $2::text, $3::timestamptz, $4::integer) AS report',
        [serviceDate, algorithmVersion, now, graceSeconds],
      );
      const report = jsonValue(result.rows[0]?.report);
      serviceDays.push(report);
      const status = reportStatus(report);
      if (status === 'failed' || status === 'blocked' || status === 'locked') {
        errors.push(`${serviceDate}: finalization ${status}`);
      }
    } catch (error) {
      errors.push(`${serviceDate}: ${message(error)}`);
    }
  }

  const monthCandidates = await selectMonths(options.pool, options.month, algorithmVersion, now, limit);
  for (const month of monthCandidates) {
    try {
      const result = await options.pool.query<{ report: unknown }>(
        'SELECT operations.seal_month($1::date, $2::text, $3::timestamptz, $4::integer) AS report',
        [month, algorithmVersion, now, monthGraceHours],
      );
      const report = jsonValue(result.rows[0]?.report);
      months.push(report);
      const status = reportStatus(report);
      if (status === 'failed' || status === 'blocked' || status === 'locked') {
        errors.push(`${month}: month sealing ${status}`);
      }
    } catch (error) {
      errors.push(`${month}: ${message(error)}`);
    }
  }

  let candidates: RetentionCandidate[] = [];
  let liveState: JsonReport | null = null;
  if (retentionMode !== 'none') {
    try {
      candidates = await retentionCandidates(options.pool, now, algorithmVersion, limit);
      if (retentionMode === 'authorize') {
        operationsSummaries.push(...await summarizeRetentionOperations(options.pool, candidates));
        candidates = await retentionCandidates(options.pool, now, algorithmVersion, limit);
        for (const candidate of candidates) {
          if (blockersWithoutAuthorization(candidate).length > 0) continue;
          try {
            const result = await options.pool.query<{ ledger_id: string | number }>(
              'SELECT operations.authorize_retention_partition($1::text, $2::date, $3::timestamptz, $4::text) AS ledger_id',
              [candidate.family, candidate.targetDate, now, algorithmVersion],
            );
            authorizations.push({
              family: candidate.family,
              targetDate: candidate.targetDate,
              ledgerId: Number(result.rows[0]?.ledger_id),
            });
          } catch (error) {
            errors.push(`${candidate.family}/${candidate.targetDate}: authorization ${message(error)}`);
          }
        }
        candidates = await retentionCandidates(options.pool, now, algorithmVersion, limit);
      } else if (retentionMode === 'apply') {
        for (const candidate of candidates) {
          if (candidate.blockers.length > 0) continue;
          try {
            const result = await options.pool.query<{ report: unknown }>(
              'SELECT operations.drop_retention_partition($1::text, $2::date, $3::timestamptz, $4::text) AS report',
              [candidate.family, candidate.targetDate, now, algorithmVersion],
            );
            drops.push(jsonValue(result.rows[0]?.report));
          } catch (error) {
            errors.push(`${candidate.family}/${candidate.targetDate}: drop ${message(error)}`);
          }
        }
        const cleanup = await options.pool.query<{ candidates: string | number; deleted: string | number }>(
          'SELECT candidates, deleted FROM operations.cleanup_live_vehicle_state($1::timestamptz, $2::integer, true)',
          [now, liveStateGraceSeconds],
        );
        liveState = {
          candidates: Number(cleanup.rows[0]?.candidates ?? 0),
          deleted: Number(cleanup.rows[0]?.deleted ?? 0),
          applied: true,
        };
        candidates = await retentionCandidates(options.pool, now, algorithmVersion, limit);
      } else {
        const cleanup = await options.pool.query<{ candidates: string | number; deleted: string | number }>(
          'SELECT candidates, deleted FROM operations.cleanup_live_vehicle_state($1::timestamptz, $2::integer, false)',
          [now, liveStateGraceSeconds],
        );
        liveState = {
          candidates: Number(cleanup.rows[0]?.candidates ?? 0),
          deleted: Number(cleanup.rows[0]?.deleted ?? 0),
          applied: false,
        };
      }
    } catch (error) {
      errors.push(`retention: ${message(error)}`);
    }
  }

  return {
    command: 'finalize',
    algorithmVersion,
    checkedAt: now.toISOString(),
    serviceDays,
    months,
    operationsSummaries,
    retention: { mode: retentionMode, candidates, authorizations, drops, liveState },
    errors,
    durationMs: Math.round(performance.now() - started),
  };
}
