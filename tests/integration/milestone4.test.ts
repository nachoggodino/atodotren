import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { canonicalizeJourneys, closeJourneys } from '@atodotren/canonical-journeys';
import { migrateToLatest } from '@atodotren/db';
import { importStaticFeed, renfeMadridMapping } from '@atodotren/gtfs-static';
import { Client, Pool } from 'pg';

import { createStoredZip } from '../helpers/zip.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required; Milestone 4 acceptance never skips PostgreSQL`);
  }
  return value;
}

function withDatabase(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function digest(...parts: readonly unknown[]): string {
  return createHash('sha256').update(parts.map(String).join('|')).digest('hex');
}

function gtfsTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const remaining = (seconds % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}:${remaining}`;
}

type JsonReport = Record<string, unknown>;

async function callReport(pool: Pool, sql: string, values: readonly unknown[]): Promise<JsonReport> {
  const result = await pool.query<{ report: unknown }>(sql, [...values]);
  const report = result.rows[0]?.report;
  assert.ok(report !== null && typeof report === 'object' && !Array.isArray(report));
  return report as JsonReport;
}

async function buildMilestone4Fixture(
  directory: string,
  serviceDate: string,
  missingServiceDate: string,
  currentServiceDate: string,
  variant = 'initial',
): Promise<string> {
  const baseDirectory = resolve('tests/fixtures/gtfs-static/representative');
  const passthrough = ['agency.txt', 'routes.txt', 'stops.txt', 'shapes.txt'] as const;
  const entries = await Promise.all(passthrough.map(async (name) => ({
    name,
    data: await readFile(join(baseDirectory, name), 'utf8'),
  })));

  const trips = [
    'route_id,service_id,trip_id,trip_headsign,direction_id,shape_id',
    `10T0001C1,ALL,10TRIP-M4-20,Boundary train ${variant},0,10SHAPE-A`,
    '10T0001C1,ALL,10TRIP-M4-D1,Reverse train,1,10SHAPE-A',
    '10T0001C1,ALL,10TRIP-M4-CAN,Partial cancellation,0,10SHAPE-A',
    '10T0001C1,ALL,10TRIP-M4-MISSING,Unseen after midnight train,0,10SHAPE-A',
    '20T0001C1,ALL,20TRIP-M4,National collision,1,20SHAPE-A',
    '',
  ].join('\n');

  const stopTimeRows = [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,timepoint',
  ];
  const forwardStops = ['10STOP-A', '10STOP-B', '10STOP-C'];
  for (let sequence = 1; sequence <= 20; sequence += 1) {
    const time = gtfsTime(36_000 + (sequence - 1) * 120);
    stopTimeRows.push(
      `10TRIP-M4-20,${time},${time},${forwardStops[(sequence - 1) % forwardStops.length]!},${sequence},0,0,1`,
    );
  }
  const reverseStops = ['10STOP-C', '10STOP-B', '10STOP-A', '10STOP-B'];
  for (let index = 0; index < reverseStops.length; index += 1) {
    const time = gtfsTime(43_200 + index * 180);
    stopTimeRows.push(`10TRIP-M4-D1,${time},${time},${reverseStops[index]!},${index + 1},0,0,1`);
  }
  const cancelStops = ['10STOP-A', '10STOP-B', '10STOP-C', '10STOP-B'];
  for (let index = 0; index < cancelStops.length; index += 1) {
    const time = gtfsTime(50_400 + index * 180);
    stopTimeRows.push(`10TRIP-M4-CAN,${time},${time},${cancelStops[index]!},${index + 1},0,0,1`);
  }
  stopTimeRows.push(
    '10TRIP-M4-MISSING,25:00:00,25:00:00,10STOP-A,1,0,0,1',
    '10TRIP-M4-MISSING,25:10:00,25:10:00,10STOP-B,2,0,0,1',
    '10TRIP-M4-MISSING,25:20:00,25:20:00,10STOP-C,3,0,0,1',
    '20TRIP-M4,10:00:00,10:00:00,20STOP-A,1,0,0,1',
    '20TRIP-M4,10:30:00,10:30:00,20STOP-B,2,0,0,1',
    '',
  );

  const calendar = [
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
    'ALL,0,0,0,0,0,0,0,20200101,20351231',
    '',
  ].join('\n');
  const calendarDates = [
    'service_id,date,exception_type',
    `ALL,${serviceDate.replaceAll('-', '')},1`,
    `ALL,${missingServiceDate.replaceAll('-', '')},1`,
    `ALL,${currentServiceDate.replaceAll('-', '')},1`,
    '',
  ].join('\n');

  const fixturePath = join(directory, `milestone4-${variant}.zip`);
  await writeFile(fixturePath, createStoredZip([
    ...entries,
    { name: 'trips.txt', data: trips },
    { name: 'stop_times.txt', data: stopTimeRows.join('\n') },
    { name: 'calendar.txt', data: calendar },
    { name: 'calendar_dates.txt', data: calendarDates },
  ]));
  return fixturePath;
}

type EvidenceClass = 'reported_prediction' | 'observed_presence' | 'stop_skipped' | 'trip_cancellation';

async function insertEvidence(
  pool: Pool,
  options: {
    readonly capturedAt: Date;
    readonly feedVersionId: string;
    readonly serviceDate: string;
    readonly tripId: string;
    readonly stopSequence: number | null;
    readonly classification: EvidenceClass;
    readonly arrivalDelay?: number;
    readonly discriminator: string;
  },
): Promise<void> {
  const idempotencyKey = digest(
    options.feedVersionId,
    options.serviceDate,
    options.tripId,
    options.stopSequence,
    options.classification,
    options.discriminator,
  );
  const evidenceKey = `${options.tripId}:${options.stopSequence ?? 'trip'}:${options.classification}:${options.discriminator}`;
  await pool.query(`
    INSERT INTO ingest.stop_evidence (
      captured_at, idempotency_key, evidence_key, evidence_checksum, feed_kind,
      feed_version_id, source_trip_id, service_date, start_time, start_date_source,
      stop_id, stop_sequence, station_id, renfe_arrival_time, renfe_arrival_delay,
      trip_relationship, stop_relationship, source_timestamp,
      matching_method, matching_version, evidence_classification
    )
    SELECT
      $1::timestamptz, $2, $3, $2,
      CASE WHEN $8 = 'observed_presence' THEN 'vehicle_positions' ELSE 'trip_updates' END,
      $4, $5, $6::date, NULL, 'provided',
      stop_time.stop_id, $7, station_map.station_id, NULL, $9,
      CASE WHEN $8 = 'trip_cancellation' THEN 'CANCELED' ELSE 'SCHEDULED' END,
      CASE WHEN $8 = 'stop_skipped' THEN 'SKIPPED' ELSE 'SCHEDULED' END,
      extract(epoch FROM $1::timestamptz)::bigint,
      'active-exact-trip', 'm4-acceptance-v1', $8
    FROM (SELECT 1) AS singleton
    LEFT JOIN gtfs_static.stop_time AS stop_time
      ON stop_time.feed_version_id = $4 AND stop_time.trip_id = $5 AND stop_time.stop_sequence = $7
    LEFT JOIN gtfs_static.stop_station_map AS station_map
      ON station_map.feed_version_id = stop_time.feed_version_id
     AND station_map.stop_id = stop_time.stop_id
  `, [
    options.capturedAt,
    idempotencyKey,
    evidenceKey,
    options.feedVersionId,
    options.tripId,
    options.serviceDate,
    options.stopSequence,
    options.classification,
    options.arrivalDelay ?? null,
  ]);
}

const adminBaseUrl = requiredEnvironment('TEST_ADMIN_DATABASE_URL');
const migratorBaseUrl = requiredEnvironment('TEST_MIGRATOR_DATABASE_URL');
const workerBaseUrl = requiredEnvironment('TEST_WORKER_DATABASE_URL');
const databaseName = `atodotren_m4_${process.pid}_${Date.now()}`;
const adminDatabaseUrl = withDatabase(adminBaseUrl, databaseName);
const migratorDatabaseUrl = withDatabase(migratorBaseUrl, databaseName);
const workerDatabaseUrl = withDatabase(workerBaseUrl, databaseName);
const baseConnectionOptions = {
  sslMode: 'disable' as const,
  poolMax: 2,
  connectionTimeoutMs: 5_000,
  idleTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
};

void test('Milestone 4 aggregation, repair, sealing, least privilege, and destructive retention gate', async () => {
  const clusterAdmin = new Client({ connectionString: adminBaseUrl });
  await clusterAdmin.connect();
  let pool: Pool | undefined;
  let databaseAdmin: Client | undefined;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'atodotren-m4-'));
  try {
    await clusterAdmin.query(`CREATE DATABASE ${databaseName}`);
    databaseAdmin = new Client({ connectionString: adminDatabaseUrl });
    await databaseAdmin.connect();
    await databaseAdmin.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await databaseAdmin.query(`GRANT CREATE ON DATABASE ${databaseName} TO atodotren_migration_admin`);

    const migrated = await migrateToLatest({
      connection: {
        ...baseConnectionOptions,
        url: migratorDatabaseUrl,
        applicationName: 'atodotren-m4-acceptance-migrate',
      },
      migrationsDirectory: resolve(process.cwd(), 'migrations'),
    });
    assert.equal(migrated.applied.at(-1), '0007_m4_correctness_gates.sql');

    pool = new Pool({ connectionString: workerDatabaseUrl, max: 4 });
    const dates = await pool.query<{
      current_date: string;
      target_date: string;
      target_month: string;
      neighbor_date: string;
      old_poll_date: string;
      old_poll_next: string;
      old_poll_after_next: string;
      missing_date: string;
    }>(`
      SELECT current_date::text,
        (current_date - 33)::text AS target_date,
        date_trunc('month', current_date - 33)::date::text AS target_month,
        (current_date - 32)::text AS neighbor_date,
        (current_date - 80)::text AS old_poll_date,
        (current_date - 79)::text AS old_poll_next,
        (current_date - 78)::text AS old_poll_after_next
        ,CASE
          WHEN date_trunc('month', current_date - 32) = date_trunc('month', current_date - 33)
            THEN (current_date - 32)::text
          ELSE (current_date - 34)::text
        END AS missing_date
    `);
    const dateRow = dates.rows[0];
    assert.ok(dateRow !== undefined);
    const currentDate = dateRow.current_date;
    const targetDate = dateRow.target_date;
    const targetMonth = dateRow.target_month;
    const neighborDate = dateRow.neighbor_date;
    const asOf = new Date(`${currentDate}T23:00:00Z`);

    const missingDate = dateRow.missing_date;
    const fixturePath = await buildMilestone4Fixture(temporaryDirectory, targetDate, missingDate, currentDate);
    const imported = await importStaticFeed({
      pool,
      source: { kind: 'file', path: fixturePath },
      mapping: {
        ...renfeMadridMapping,
        canaries: {
          requiredLineCodes: ['C-1'],
          requiredStationPublicIds: ['atocha', 'aeropuerto-t4'],
          minimumStations: 3,
          minimumTrips: 3,
          requireReferencedShapes: true,
        },
      },
      temporaryDirectory,
    });
    assert.equal(imported.result, 'imported', JSON.stringify(imported));
    const feedVersionId = imported.feedVersionId;
    assert.ok(feedVersionId !== undefined);
    const replacementFixturePath = await buildMilestone4Fixture(
      temporaryDirectory, targetDate, missingDate, currentDate, 'replacement',
    );
    const replacementImport = await importStaticFeed({
      pool,
      source: { kind: 'file', path: replacementFixturePath },
      mapping: {
        ...renfeMadridMapping,
        canaries: {
          requiredLineCodes: ['C-1'], requiredStationPublicIds: ['atocha', 'aeropuerto-t4'],
          minimumStations: 3, minimumTrips: 3, requireReferencedShapes: true,
        },
      },
      temporaryDirectory,
    });
    assert.equal(replacementImport.result, 'imported', JSON.stringify(replacementImport));
    assert.notEqual(replacementImport.feedVersionId, feedVersionId);
    const preferredTimetable = await pool.query<{ rows: string; versions: string }>(`
      SELECT count(*)::text AS rows, count(DISTINCT feed_version_id)::text AS versions
      FROM operations.timetable_service_dates($1::date, $1::date)
    `, [targetDate]);
    assert.deepEqual(preferredTimetable.rows[0], { rows: '1', versions: '1' });

    const partialCurrentDay = await callReport(
      pool,
      'SELECT operations.materialize_expected_service_day($1::date, $2::text, $3::timestamptz, 7200) AS report',
      [currentDate, 'aggregate-v1', asOf],
    );
    assert.equal(partialCurrentDay.status, 'blocked');
    assert.ok((partialCurrentDay.blockers as string[]).includes('service_day_grace_not_elapsed'));
    const currentLedger = await pool.query<{ expected: string; canonical: string }>(`
      SELECT (SELECT sum(expected_journey_count)::text FROM operations.expected_service_day
          WHERE service_date = $1::date) AS expected,
        (SELECT count(*)::text FROM core.journey WHERE service_date = $1::date) AS canonical
    `, [currentDate]);
    assert.deepEqual(currentLedger.rows[0], { expected: '4', canonical: '0' });
    const partialFinalize = await callReport(
      pool,
      'SELECT operations.finalize_service_day($1::date, $2::text, $3::timestamptz, 7200) AS report',
      [currentDate, 'aggregate-v1', asOf],
    );
    assert.equal(partialFinalize.status, 'blocked');
    assert.ok((partialFinalize.blockers as string[]).includes('service_day_grace_not_elapsed'));

    const histogramLaw = await databaseAdmin.query<{ associative: boolean; underflow: number; overflow: number }>(`
      SELECT
        analytics.histogram_add(
          analytics.histogram_30s(ARRAY[-301,-300,120]),
          analytics.histogram_30s(ARRAY[121,1800,2000])
        ) = analytics.histogram_30s(ARRAY[-301,-300,120,121,1800,2000]) AS associative,
        (analytics.histogram_30s(ARRAY[-301,-300,120,121,1800,2000]))[1] AS underflow,
        (analytics.histogram_30s(ARRAY[-301,-300,120,121,1800,2000]))[72] AS overflow
    `);
    assert.deepEqual(histogramLaw.rows[0], { associative: true, underflow: 1, overflow: 2 });

    const capturedBase = new Date(`${currentDate}T12:00:00Z`);
    const boundaryDelays = [
      -301, -300, -270, -1, 0, 29, 30, 119, 120, 121,
      240, 240, 60, 300, 301, 600, 900, 1799, 1800, 2000,
    ];
    for (let index = 0; index < boundaryDelays.length; index += 1) {
      await insertEvidence(pool, {
        capturedAt: new Date(capturedBase.getTime() + index * 1000),
        feedVersionId,
        serviceDate: targetDate,
        tripId: '10TRIP-M4-20',
        stopSequence: index + 1,
        classification: 'reported_prediction',
        arrivalDelay: boundaryDelays[index]!,
        discriminator: `boundary-${index}`,
      });
    }
    await insertEvidence(pool, {
      capturedAt: new Date(capturedBase.getTime() + 30_000), feedVersionId, serviceDate: targetDate,
      tripId: '10TRIP-M4-D1', stopSequence: 1, classification: 'reported_prediction',
      arrivalDelay: 121, discriminator: 'd1-reported-1',
    });
    await insertEvidence(pool, {
      capturedAt: new Date(capturedBase.getTime() + 31_000), feedVersionId, serviceDate: targetDate,
      tripId: '10TRIP-M4-D1', stopSequence: 2, classification: 'stop_skipped', discriminator: 'd1-skipped-2',
    });
    await insertEvidence(pool, {
      capturedAt: new Date(capturedBase.getTime() + 32_000), feedVersionId, serviceDate: targetDate,
      tripId: '10TRIP-M4-D1', stopSequence: 4, classification: 'reported_prediction',
      arrivalDelay: -60, discriminator: 'd1-reported-4',
    });
    await insertEvidence(pool, {
      capturedAt: new Date(capturedBase.getTime() + 40_000), feedVersionId, serviceDate: targetDate,
      tripId: '10TRIP-M4-CAN', stopSequence: 1, classification: 'reported_prediction',
      arrivalDelay: 240, discriminator: 'cancel-reported-1',
    });
    await insertEvidence(pool, {
      capturedAt: new Date(capturedBase.getTime() + 41_000), feedVersionId, serviceDate: targetDate,
      tripId: '10TRIP-M4-CAN', stopSequence: 1, classification: 'observed_presence', discriminator: 'cancel-observed-1',
    });
    await insertEvidence(pool, {
      capturedAt: new Date(capturedBase.getTime() + 42_000), feedVersionId, serviceDate: targetDate,
      tripId: '10TRIP-M4-CAN', stopSequence: null, classification: 'trip_cancellation', discriminator: 'cancel-trip',
    });

    const canonical = await canonicalizeJourneys({ pool, serviceDate: targetDate, limit: 20 });
    assert.deepEqual(canonical.errors, {}, JSON.stringify(canonical));
    const canonicalCounts = await pool.query<{ journeys: string; stops: string }>(`
      SELECT (SELECT count(*) FROM core.journey WHERE service_date = $1::date)::text AS journeys,
        (SELECT count(*) FROM core.journey_stop WHERE service_date = $1::date)::text AS stops
    `, [targetDate]);
    assert.deepEqual(canonicalCounts.rows[0], { journeys: '3', stops: '28' });

    const firstAggregate = await callReport(
      pool,
      'SELECT analytics.recompute_daily($1::date, $2::text) AS report',
      [targetDate, 'aggregate-v1'],
    );
    assert.equal(firstAggregate.status, 'succeeded');
    assert.equal(typeof firstAggregate.aggregateChecksum, 'string');
    const deterministicChecksum = firstAggregate.aggregateChecksum;

    const boundary = await pool.query<{
      scheduled: string; valid: string; punctual: string; early: string; zero_two: string;
      two_five: string; five_ten: string; ten_fifteen: string; over_fifteen: string;
      histogram_total: string; underflow: string; overflow: string;
    }>(`
      SELECT sum(scheduled_opportunities)::text AS scheduled,
        sum(valid_delay_observations)::text AS valid,
        sum(punctual_count)::text AS punctual,
        sum(early_count)::text AS early,
        sum(zero_to_two_count)::text AS zero_two,
        sum(over_two_to_five_count)::text AS two_five,
        sum(over_five_to_ten_count)::text AS five_ten,
        sum(over_ten_to_fifteen_count)::text AS ten_fifteen,
        sum(over_fifteen_count)::text AS over_fifteen,
        sum(histogram_bins.total)::text AS histogram_total,
        sum(delay_histogram[1])::text AS underflow,
        sum(delay_histogram[72])::text AS overflow
      FROM analytics.daily_stop_call_hour
      CROSS JOIN LATERAL (SELECT sum(bin)::bigint AS total FROM unnest(delay_histogram) AS bin) AS histogram_bins
      WHERE service_date = $1::date AND scheduled_hour = 10
    `, [targetDate]);
    assert.deepEqual(boundary.rows[0], {
      scheduled: '20', valid: '20', punctual: '10', early: '4', zero_two: '6',
      two_five: '4', five_ten: '2', ten_fifteen: '1', over_fifteen: '3',
      histogram_total: '20', underflow: '1', overflow: '2',
    });

    const segments = await pool.query<{
      scheduled: string; valid: string; signed_sum: string; zero_delta: string; recovery_delta: string;
    }>(`
      SELECT sum(scheduled_opportunities)::text AS scheduled,
        sum(valid_delay_observations)::text AS valid,
        sum(signed_delay_sum)::text AS signed_sum,
        count(*) FILTER (WHERE minimum_delay_seconds = 0 AND maximum_delay_seconds = 0)::text AS zero_delta,
        count(*) FILTER (WHERE minimum_delay_seconds = -180 AND maximum_delay_seconds = -180)::text AS recovery_delta
      FROM analytics.daily_segment_hour
      WHERE service_date = $1::date AND upstream_scheduled_hour = 10
    `, [targetDate]);
    assert.deepEqual(segments.rows[0], {
      scheduled: '19', valid: '19', signed_sum: '2301', zero_delta: '1', recovery_delta: '1',
    });

    const grains = await pool.query<{ directions: string; line_journeys: string; network_journeys: string }>(`
      SELECT
        (SELECT count(DISTINCT direction) FROM analytics.daily_stop_call_hour WHERE service_date = $1::date)::text AS directions,
        (SELECT sum(scheduled_opportunities) FROM analytics.daily_line_summary WHERE service_date = $1::date)::text AS line_journeys,
        (SELECT sum(scheduled_opportunities) FROM analytics.daily_network_summary WHERE service_date = $1::date)::text AS network_journeys
    `, [targetDate]);
    assert.deepEqual(grains.rows[0], { directions: '2', line_journeys: '3', network_journeys: '3' });

    await pool.query('SELECT analytics.mark_dirty($1::date, $2::text)', [targetDate, 'acceptance-deterministic-rebuild']);
    const rebuilt = await callReport(
      pool,
      'SELECT analytics.recompute_daily($1::date, $2::text) AS report',
      [targetDate, 'aggregate-v1'],
    );
    assert.equal(rebuilt.status, 'succeeded');
    assert.equal(rebuilt.aggregateChecksum, deterministicChecksum);
    const noop = await callReport(
      pool,
      'SELECT analytics.recompute_daily($1::date, $2::text) AS report',
      [targetDate, 'aggregate-v1'],
    );
    assert.equal(noop.status, 'noop');

    const beforeVerification = await pool.query<{ blockers: string[]; authorized: boolean }>(`
      SELECT blockers, authorized
      FROM operations.retention_candidates($1::timestamptz, 'aggregate-v1')
      WHERE family = 'canonical_detail' AND target_date = $2::date
    `, [asOf, targetDate]);
    assert.equal(beforeVerification.rows[0]?.authorized, false);
    assert.ok(beforeVerification.rows[0]?.blockers.includes('service_day_not_verified'));
    assert.ok(beforeVerification.rows[0]?.blockers.includes('month_not_sealed'));
    await assert.rejects(
      pool.query(
        "SELECT operations.drop_retention_partition('canonical_detail', $1::date, $2::timestamptz, 'aggregate-v1')",
        [targetDate, asOf],
      ),
      /Retention drop blocked/u,
    );
    await assert.rejects(
      pool.query(
        "SELECT operations.authorize_retention_partition('canonical_detail', $1::date, $2::timestamptz, 'aggregate-v1')",
        [targetDate, asOf],
      ),
      /Retention authorization blocked/u,
    );

    const closed = await closeJourneys({ pool, serviceDate: targetDate, now: asOf, graceSeconds: 7_200 });
    assert.deepEqual(closed.errors, {}, JSON.stringify(closed));
    const expectedMaterialization = await callReport(
      pool,
      'SELECT operations.materialize_expected_service_day($1::date, $2::text, $3::timestamptz, 7200) AS report',
      [targetDate, 'aggregate-v1', asOf],
    );
    assert.equal(expectedMaterialization.journeysCreated, 1);
    assert.equal(expectedMaterialization.stopsCreated, 3);
    const timetableJourneyBeforeClaim = await pool.query<{ id: string }>(`
      SELECT id::text FROM core.journey
      WHERE service_date = $1::date AND source_trip_id = '10TRIP-M4-MISSING'
    `, [targetDate]);
    assert.ok(timetableJourneyBeforeClaim.rows[0]?.id !== undefined);
    await insertEvidence(pool, {
      capturedAt: new Date(capturedBase.getTime() + 50_000), feedVersionId, serviceDate: targetDate,
      tripId: '10TRIP-M4-MISSING', stopSequence: 1, classification: 'reported_prediction',
      arrivalDelay: 60, discriminator: 'late-timetable-claim',
    });
    const claimed = await canonicalizeJourneys({ pool, serviceDate: targetDate, limit: 20 });
    assert.deepEqual(claimed.errors, {}, JSON.stringify(claimed));
    const timetableJourneyAfterClaim = await pool.query<{
      id: string; opportunity_source: string; first_evidence_at: Date | null; journeys: string;
    }>(`
      SELECT journey.id::text, journey.opportunity_source, journey.first_evidence_at,
        (SELECT count(*)::text FROM core.journey AS all_journeys
         WHERE all_journeys.service_date = $1::date
           AND all_journeys.source_trip_id = '10TRIP-M4-MISSING') AS journeys
      FROM core.journey AS journey
      WHERE journey.service_date = $1::date AND journey.source_trip_id = '10TRIP-M4-MISSING'
    `, [targetDate]);
    assert.deepEqual({
      id: timetableJourneyAfterClaim.rows[0]?.id,
      opportunitySource: timetableJourneyAfterClaim.rows[0]?.opportunity_source,
      hasEvidence: timetableJourneyAfterClaim.rows[0]?.first_evidence_at instanceof Date,
      journeys: timetableJourneyAfterClaim.rows[0]?.journeys,
    }, {
      id: timetableJourneyBeforeClaim.rows[0]?.id,
      opportunitySource: 'realtime_evidence', hasEvidence: true, journeys: '1',
    });
    const finalAggregateV1 = await callReport(
      pool,
      'SELECT analytics.recompute_daily($1::date, $2::text) AS report',
      [targetDate, 'aggregate-v1'],
    );
    assert.equal(finalAggregateV1.status, 'succeeded');

    const finalizedStatuses = await pool.query<{
      scheduled: string; valid: string; punctual: string; canceled: string; skipped: string;
      missing: string; pending: string; reported: string; observed: string;
    }>(`
      SELECT sum(scheduled_opportunities)::text AS scheduled,
        sum(valid_delay_observations)::text AS valid,
        sum(punctual_count)::text AS punctual,
        sum(canceled_count)::text AS canceled,
        sum(skipped_count)::text AS skipped,
        sum(missing_evidence_count)::text AS missing,
        sum(pending_count)::text AS pending,
        sum(reported_only_count)::text AS reported,
        sum(observed_presence_count)::text AS observed
      FROM analytics.daily_stop_call_hour WHERE service_date = $1::date
    `, [targetDate]);
    assert.deepEqual(finalizedStatuses.rows[0], {
      scheduled: '31', valid: '24', punctual: '12', canceled: '3', skipped: '1',
      missing: '3', pending: '0', reported: '23', observed: '1',
    });

    const lockClient = new Client({ connectionString: workerDatabaseUrl });
    await lockClient.connect();
    try {
      await lockClient.query('BEGIN');
      await lockClient.query("SELECT pg_advisory_xact_lock(hashtextextended('finalize:' || $1::text, 0))", [targetDate]);
      const locked = await callReport(
        pool,
        'SELECT operations.finalize_service_day($1::date, $2::text, $3::timestamptz, 7200) AS report',
        [targetDate, 'aggregate-v1', asOf],
      );
      assert.equal(locked.status, 'locked');
      await lockClient.query('ROLLBACK');
    } finally {
      await lockClient.query('ROLLBACK').catch(() => undefined);
      await lockClient.end();
    }

    const finalizedV1 = await callReport(
      pool,
      'SELECT operations.finalize_service_day($1::date, $2::text, $3::timestamptz, 7200) AS report',
      [targetDate, 'aggregate-v1', asOf],
    );
    assert.equal(finalizedV1.status, 'verified', JSON.stringify(finalizedV1));
    const contributionV1 = await pool.query<{ stop: string; segment: string; journey: string }>(`
      SELECT
        COALESCE(sum(scheduled_opportunities) FILTER (WHERE family = 'stop'), 0)::text AS stop,
        COALESCE(sum(scheduled_opportunities) FILTER (WHERE family = 'segment'), 0)::text AS segment,
        COALESCE(sum(scheduled_opportunities) FILTER (WHERE family = 'journey'), 0)::text AS journey
      FROM analytics.daily_schedule_contribution
      WHERE service_date = $1::date AND aggregate_algorithm_version = 'aggregate-v1'
    `, [targetDate]);
    assert.deepEqual(contributionV1.rows[0], { stop: '31', segment: '27', journey: '4' });
    const civilAfterMidnight = await pool.query<{
      weekday_class: string; scheduled_seconds: number; service_day_seconds: number; civil_date: string;
    }>(`
      SELECT weekday_class, scheduled_seconds, service_day_seconds, civil_date::text
      FROM analytics.daily_schedule_contribution
      WHERE service_date = $1::date AND family = 'stop' AND service_day_seconds = 90000
    `, [targetDate]);
    const nextCivilDate = new Date(new Date(`${targetDate}T00:00:00Z`).getTime() + 86_400_000);
    const weekdayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
    assert.deepEqual(civilAfterMidnight.rows[0], {
      weekday_class: weekdayNames[nextCivilDate.getUTCDay()],
      scheduled_seconds: 3600,
      service_day_seconds: 90000,
      civil_date: nextCivilDate.toISOString().slice(0, 10),
    });

    await insertEvidence(pool, {
      capturedAt: new Date(capturedBase.getTime() + 60_000),
      feedVersionId,
      serviceDate: targetDate,
      tripId: '10TRIP-M4-20',
      stopSequence: 20,
      classification: 'reported_prediction',
      arrivalDelay: 2_001,
      discriminator: 'newer-than-canonical-watermark',
    });
    const evidenceRetention = await pool.query<{ blockers: string[] }>(`
      SELECT blockers
      FROM operations.retention_candidates($1::timestamptz, 'aggregate-v1')
      WHERE family = 'stop_evidence' AND target_date = $2::date
    `, [new Date(new Date(`${currentDate}T12:00:00Z`).getTime() + 9 * 86_400_000), currentDate]);
    assert.ok(evidenceRetention.rows[0]?.blockers.includes('canonical_evidence_watermark_incomplete'));

    await pool.query(`
      INSERT INTO ingest.live_vehicle_state (
        state_key, feed_version_id, source_trip_id, service_date, start_time,
        line_id, branch_id, service_pattern_id, entity_id, current_status,
        feed_header_timestamp, captured_at, content_checksum
      )
      SELECT 'm4-expired-live-state', feed_version_id, source_trip_id, service_date, start_time,
        line_id, branch_id, service_pattern_id, 'm4-entity', 'UNKNOWN', 1, $2::timestamptz, repeat('a', 64)
      FROM core.journey WHERE service_date = $1::date ORDER BY id LIMIT 1
    `, [targetDate, new Date(asOf.getTime() - 86_400_000)]);
    const directDelete = await pool.query<{ can_delete: boolean }>(
      "SELECT has_table_privilege(current_user, 'ingest.live_vehicle_state', 'DELETE') AS can_delete",
    );
    assert.equal(directDelete.rows[0]?.can_delete, false);
    const liveDry = await pool.query<{ candidates: string; deleted: string }>(
      'SELECT candidates::text, deleted::text FROM operations.cleanup_live_vehicle_state($1::timestamptz, 0, false)',
      [asOf],
    );
    assert.deepEqual(liveDry.rows[0], { candidates: '1', deleted: '0' });
    const liveApply = await pool.query<{ candidates: string; deleted: string }>(
      'SELECT candidates::text, deleted::text FROM operations.cleanup_live_vehicle_state($1::timestamptz, 0, true)',
      [asOf],
    );
    assert.deepEqual(liveApply.rows[0], { candidates: '1', deleted: '1' });

    const repairedOpenMonth = await canonicalizeJourneys({
      pool,
      serviceDate: targetDate,
      limit: 20,
      algorithmVersion: 'canonical-v2',
      repairVersion: 1,
      repairReason: 'milestone4-open-month-replacement',
    });
    assert.deepEqual(repairedOpenMonth.errors, {}, JSON.stringify(repairedOpenMonth));
    const invalidated = await pool.query<{ finalizations: string; contributions: string }>(`
      SELECT
        (SELECT count(*) FROM operations.service_day_finalization
          WHERE service_date = $1::date AND aggregate_algorithm_version = 'aggregate-v1')::text AS finalizations,
        (SELECT count(*) FROM analytics.daily_schedule_contribution
          WHERE service_date = $1::date AND aggregate_algorithm_version = 'aggregate-v1')::text AS contributions
    `, [targetDate]);
    assert.deepEqual(invalidated.rows[0], { finalizations: '0', contributions: '0' });

    const replacementAggregate = await callReport(
      pool,
      'SELECT analytics.recompute_daily($1::date, $2::text) AS report',
      [targetDate, 'aggregate-v1'],
    );
    assert.equal(replacementAggregate.status, 'succeeded');
    const replacementFinalization = await callReport(
      pool,
      'SELECT operations.finalize_service_day($1::date, $2::text, $3::timestamptz, 7200) AS report',
      [targetDate, 'aggregate-v1', asOf],
    );
    assert.equal(replacementFinalization.status, 'verified');
    const replacementOpportunity = await pool.query<{ opportunities: string }>(`
      SELECT sum(scheduled_opportunities)::text AS opportunities
      FROM analytics.daily_schedule_contribution
      WHERE service_date = $1::date AND aggregate_algorithm_version = 'aggregate-v1'
    `, [targetDate]);
    assert.equal(replacementOpportunity.rows[0]?.opportunities, '62');

    await databaseAdmin.query(`
      INSERT INTO operations.daily_feed_coverage (
        service_date, feed_kind, poll_count, successful_poll_count, matched_madrid_count,
        non_madrid_count, unmatched_count, invalid_count, evidence_changed_count,
        response_bytes, first_poll_at, last_poll_at, source_checksum
      ) VALUES ($1::date, 'trip_updates', 1, 1, 3, 0, 0, 0, 3, 1,
        $1::date::timestamptz, $1::date::timestamptz, repeat('a', 64))
      ON CONFLICT (service_date, feed_kind) DO UPDATE SET
        poll_count = EXCLUDED.poll_count,
        successful_poll_count = EXCLUDED.successful_poll_count
    `, [targetDate]);
    const refreshedTargetQuality = await callReport(
      pool,
      'SELECT operations.finalize_service_day($1::date, $2::text, $3::timestamptz, 7200) AS report',
      [targetDate, 'aggregate-v1', asOf],
    );
    assert.equal(refreshedTargetQuality.qualityStatus, 'complete');

    const missingDayBlock = await callReport(
      pool,
      'SELECT operations.seal_month($1::date, $2::text, $3::timestamptz, 0) AS report',
      [targetMonth, 'aggregate-v1', asOf],
    );
    assert.equal(missingDayBlock.status, 'blocked');
    assert.ok((missingDayBlock.blockers as string[]).includes('not_all_expected_service_days_verified'));

    const missingMaterialization = await callReport(
      pool,
      'SELECT operations.materialize_expected_service_day($1::date, $2::text, $3::timestamptz, 7200) AS report',
      [missingDate, 'aggregate-v1', asOf],
    );
    assert.equal(missingMaterialization.journeysCreated, 4);
    await callReport(pool, 'SELECT analytics.recompute_daily($1::date, $2::text) AS report', [missingDate, 'aggregate-v1']);
    const missingFinalization = await callReport(
      pool,
      'SELECT operations.finalize_service_day($1::date, $2::text, $3::timestamptz, 7200) AS report',
      [missingDate, 'aggregate-v1', asOf],
    );
    assert.equal(missingFinalization.status, 'verified', JSON.stringify(missingFinalization));
    await databaseAdmin.query(`
      INSERT INTO operations.daily_feed_coverage (
        service_date, feed_kind, poll_count, successful_poll_count, matched_madrid_count,
        non_madrid_count, unmatched_count, invalid_count, evidence_changed_count,
        response_bytes, first_poll_at, last_poll_at, source_checksum
      ) VALUES ($1::date, 'trip_updates', 1, 0, 0, 0, 0, 0, 0, 1,
        $1::date::timestamptz, $1::date::timestamptz, repeat('b', 64))
    `, [missingDate]);
    const refreshedOutageQuality = await callReport(
      pool,
      'SELECT operations.finalize_service_day($1::date, $2::text, $3::timestamptz, 7200) AS report',
      [missingDate, 'aggregate-v1', asOf],
    );
    assert.equal(refreshedOutageQuality.qualityStatus, 'incomplete');
    const acknowledgedOutage = await callReport(
      pool,
      'SELECT operations.acknowledge_incomplete_service_day($1::date, $2::text) AS report',
      [missingDate, 'confirmed complete Renfe outage'],
    );
    assert.equal(acknowledgedOutage.status, 'incomplete_acknowledged');

    await databaseAdmin.query(`
      UPDATE analytics.daily_schedule_contribution
      SET scheduled_opportunities = scheduled_opportunities + 1
      WHERE id = (
        SELECT id FROM analytics.daily_schedule_contribution
        WHERE service_date = $1::date AND aggregate_algorithm_version = 'aggregate-v1'
        ORDER BY id LIMIT 1
      )
    `, [targetDate]);
    const staleContribution = await callReport(
      pool,
      'SELECT operations.seal_month($1::date, $2::text, $3::timestamptz, 0) AS report',
      [targetMonth, 'aggregate-v1', asOf],
    );
    assert.equal(staleContribution.status, 'blocked');
    assert.ok((staleContribution.blockers as string[]).includes('daily_schedule_contribution_checksum_mismatch'));
    await databaseAdmin.query(`
      UPDATE analytics.daily_schedule_contribution
      SET scheduled_opportunities = scheduled_opportunities - 1
      WHERE id = (
        SELECT id FROM analytics.daily_schedule_contribution
        WHERE service_date = $1::date AND aggregate_algorithm_version = 'aggregate-v1'
        ORDER BY id LIMIT 1
      )
    `, [targetDate]);

    const preGraceSeal = await callReport(
      pool,
      `SELECT operations.seal_month($1::date, $2::text,
         ($1::date + interval '1 month 1 hour')::timestamptz, 48) AS report`,
      [targetMonth, 'aggregate-v1'],
    );
    assert.equal(preGraceSeal.status, 'blocked');
    assert.ok((preGraceSeal.blockers as string[]).includes('month_sealing_grace_not_elapsed'));
    const preGraceClassifiedRows = await pool.query<{ rows: string }>(`
      SELECT count(*)::text AS rows FROM analytics.monthly_schedule_classification
      WHERE calendar_month = $1::date AND aggregate_algorithm_version = 'aggregate-v1'
    `, [targetMonth]);
    assert.equal(preGraceClassifiedRows.rows[0]?.rows, '0');

    const emptyMonth = await callReport(
      pool,
      "SELECT operations.seal_month(date '2010-01-01', $1::text, $2::timestamptz, 0) AS report",
      ['aggregate-v1', asOf],
    );
    assert.equal(emptyMonth.status, 'blocked');
    assert.ok((emptyMonth.blockers as string[]).includes('no_expected_service_days'));

    const sealedV1 = await callReport(
      pool,
      'SELECT operations.seal_month($1::date, $2::text, $3::timestamptz, 0) AS report',
      [targetMonth, 'aggregate-v1', asOf],
    );
    assert.equal(sealedV1.status, 'sealed', JSON.stringify(sealedV1));
    assert.equal(sealedV1.qualityStatus, 'incomplete_acknowledged');
    const sealedV1Checksum = sealedV1.checksum;
    assert.equal(typeof sealedV1Checksum, 'string');
    const retainedCalendarClass = await pool.query<{ rows: string; raw_after_midnight: string }>(`
      SELECT count(*)::text AS rows,
        count(*) FILTER (WHERE service_day_seconds = 90000 AND scheduled_seconds = 3600)::text
          AS raw_after_midnight
      FROM analytics.monthly_schedule_classification
      WHERE calendar_month = $1::date AND aggregate_algorithm_version = 'aggregate-v1'
        AND day_class IS NOT NULL AND calendar_classification_version = 'calendar-v1'
    `, [targetMonth]);
    assert.ok(Number(retainedCalendarClass.rows[0]?.rows) > 0);
    assert.equal(retainedCalendarClass.rows[0]?.raw_after_midnight, '6');
    const compactShape = await pool.query<{ service_date: string; id: string }>(`
      SELECT count(*) FILTER (WHERE column_name = 'service_date')::text AS service_date,
        count(*) FILTER (WHERE column_name = 'id')::text AS id
      FROM information_schema.columns
      WHERE table_schema = 'analytics' AND table_name = 'monthly_schedule_classification'
    `);
    assert.deepEqual(compactShape.rows[0], { service_date: '0', id: '0' });
    const sealedAgain = await callReport(
      pool,
      'SELECT operations.seal_month($1::date, $2::text, $3::timestamptz, 0) AS report',
      [targetMonth, 'aggregate-v1', asOf],
    );
    assert.equal(sealedAgain.status, 'already_sealed');
    assert.equal(sealedAgain.checksum, sealedV1Checksum);

    const repairedSealedMonth = await canonicalizeJourneys({
      pool,
      serviceDate: targetDate,
      limit: 20,
      algorithmVersion: 'canonical-v3',
      repairVersion: 2,
      repairReason: 'milestone4-sealed-month-methodology-change',
    });
    assert.deepEqual(repairedSealedMonth.errors, {}, JSON.stringify(repairedSealedMonth));
    const preservedSeal = await pool.query<{ finalizations: string; seal_checksum: string }>(`
      SELECT
        (SELECT count(*) FROM operations.service_day_finalization
          WHERE service_date = $1::date AND aggregate_algorithm_version = 'aggregate-v1')::text AS finalizations,
        (SELECT aggregate_checksum FROM operations.month_seal
          WHERE calendar_month = $2::date AND aggregate_algorithm_version = 'aggregate-v1') AS seal_checksum
    `, [targetDate, targetMonth]);
    assert.deepEqual(preservedSeal.rows[0], { finalizations: '1', seal_checksum: sealedV1Checksum });

    const blockedSameVersion = await callReport(
      pool,
      'SELECT analytics.recompute_daily($1::date, $2::text) AS report',
      [targetDate, 'aggregate-v1'],
    );
    assert.equal(blockedSameVersion.status, 'blocked');
    assert.equal(blockedSameVersion.blocker, 'sealed_version_requires_new_algorithm');

    const aggregateV2 = await callReport(
      pool,
      'SELECT analytics.recompute_daily($1::date, $2::text) AS report',
      [targetDate, 'aggregate-v2'],
    );
    assert.equal(aggregateV2.status, 'succeeded');
    const dailyVersions = await pool.query<{ versions: string[] }>(`
      SELECT array_agg(DISTINCT aggregate_algorithm_version ORDER BY aggregate_algorithm_version) AS versions
      FROM analytics.daily_stop_call_hour WHERE service_date = $1::date
    `, [targetDate]);
    assert.deepEqual(dailyVersions.rows[0]?.versions, ['aggregate-v2']);

    const finalizedV2 = await callReport(
      pool,
      'SELECT operations.finalize_service_day($1::date, $2::text, $3::timestamptz, 7200) AS report',
      [targetDate, 'aggregate-v2', asOf],
    );
    assert.equal(finalizedV2.status, 'verified', JSON.stringify(finalizedV2));
    await assert.rejects(
      pool.query(
        "SELECT operations.authorize_retention_partition('canonical_detail', $1::date, $2::timestamptz, 'aggregate-v2')",
        [targetDate, asOf],
      ),
      /month_not_sealed/u,
    );

    await pool.query('SELECT analytics.mark_dirty($1::date, $2::text)', [missingDate, 'aggregate-v2-month-completeness']);
    const missingAggregateV2 = await callReport(
      pool, 'SELECT analytics.recompute_daily($1::date, $2::text) AS report', [missingDate, 'aggregate-v2'],
    );
    assert.equal(missingAggregateV2.status, 'succeeded');
    const missingFinalizationV2 = await callReport(
      pool,
      'SELECT operations.finalize_service_day($1::date, $2::text, $3::timestamptz, 7200) AS report',
      [missingDate, 'aggregate-v2', asOf],
    );
    assert.equal(missingFinalizationV2.status, 'verified', JSON.stringify(missingFinalizationV2));

    const sealedV2 = await callReport(
      pool,
      'SELECT operations.seal_month($1::date, $2::text, $3::timestamptz, 0) AS report',
      [targetMonth, 'aggregate-v2', asOf],
    );
    assert.equal(sealedV2.status, 'sealed', JSON.stringify(sealedV2));
    const v1StillSealed = await pool.query<{ checksum: string; rows: string }>(`
      SELECT seal.aggregate_checksum AS checksum,
        ((SELECT count(*) FROM analytics.monthly_stop_schedule
           WHERE calendar_month = $1::date AND aggregate_algorithm_version = 'aggregate-v1') +
         (SELECT count(*) FROM analytics.monthly_segment_schedule
           WHERE calendar_month = $1::date AND aggregate_algorithm_version = 'aggregate-v1') +
         (SELECT count(*) FROM analytics.monthly_journey_schedule
           WHERE calendar_month = $1::date AND aggregate_algorithm_version = 'aggregate-v1'))::text AS rows
      FROM operations.month_seal AS seal
      WHERE seal.calendar_month = $1::date AND seal.aggregate_algorithm_version = 'aggregate-v1'
    `, [targetMonth]);
    assert.equal(v1StillSealed.rows[0]?.checksum, sealedV1Checksum);
    assert.ok(Number(v1StillSealed.rows[0]?.rows) > 0);

    const canonicalAuthorization = await pool.query<{ ledger_id: string }>(
      "SELECT operations.authorize_retention_partition('canonical_detail', $1::date, $2::timestamptz, 'aggregate-v2')::text AS ledger_id",
      [targetDate, asOf],
    );
    assert.ok(Number(canonicalAuthorization.rows[0]?.ledger_id) > 0);
    const canonicalCandidate = await pool.query<{ blockers: string[]; authorized: boolean; source_rows: string }>(`
      SELECT blockers, authorized, source_rows::text
      FROM operations.retention_candidates($1::timestamptz, 'aggregate-v2')
      WHERE family = 'canonical_detail' AND target_date = $2::date
    `, [asOf, targetDate]);
    assert.deepEqual(canonicalCandidate.rows[0]?.blockers, []);
    assert.equal(canonicalCandidate.rows[0]?.authorized, true);
    assert.equal(canonicalCandidate.rows[0]?.source_rows, '35');

    const canonicalDrop = await callReport(
      pool,
      "SELECT operations.drop_retention_partition('canonical_detail', $1::date, $2::timestamptz, 'aggregate-v2') AS report",
      [targetDate, asOf],
    );
    assert.equal(canonicalDrop.status, 'dropped');
    assert.equal(canonicalDrop.droppedRows, 35);
    const partitionState = await pool.query<{ journey: string | null; stops: string | null; neighbor: string | null }>(`
      SELECT to_regclass('core.journey_' || to_char($1::date, 'YYYYMMDD'))::text AS journey,
        to_regclass('core.journey_stop_' || to_char($1::date, 'YYYYMMDD'))::text AS stops,
        to_regclass('core.journey_' || to_char($2::date, 'YYYYMMDD'))::text AS neighbor
    `, [targetDate, neighborDate]);
    assert.deepEqual(partitionState.rows[0], {
      journey: null,
      stops: null,
      neighbor: `core.journey_${neighborDate.replaceAll('-', '')}`,
    });

    const oldPollDate = dateRow.old_poll_date;
    const oldPollNext = dateRow.old_poll_next;
    const oldPollAfterNext = dateRow.old_poll_after_next;
    for (const value of [oldPollDate, oldPollNext, oldPollAfterNext]) {
      assert.match(value, /^\d{4}-\d{2}-\d{2}$/u);
    }
    const oldSuffix = oldPollDate.replaceAll('-', '');
    const neighborSuffix = oldPollNext.replaceAll('-', '');
    await databaseAdmin.query('SET ROLE atodotren_migration_admin');
    try {
      await databaseAdmin.query(`
        CREATE TABLE ingest.poll_run_${oldSuffix}
        PARTITION OF ingest.poll_run
        FOR VALUES FROM ('${oldPollDate} 00:00:00+00') TO ('${oldPollNext} 00:00:00+00')
      `);
      await databaseAdmin.query(`
        CREATE TABLE ingest.poll_run_${neighborSuffix}
        PARTITION OF ingest.poll_run
        FOR VALUES FROM ('${oldPollNext} 00:00:00+00') TO ('${oldPollAfterNext} 00:00:00+00')
      `);
    } finally {
      await databaseAdmin.query('RESET ROLE');
    }
    await pool.query(`
      INSERT INTO ingest.poll_run (
        captured_at, idempotency_key, feed_kind, started_at, completed_at,
        feed_header_timestamp, http_status, result_class, response_bytes, entity_total,
        matched_madrid_count, non_madrid_count, unmatched_count, invalid_count,
        evidence_changed_count, evidence_repeated_count, response_duration_ms, persistence_duration_ms
      ) VALUES (
        $1::timestamptz, $2, 'trip_updates', $1::timestamptz, $1::timestamptz,
        1, 200, 'success', 100, 1, 1, 0, 0, 0, 1, 0, 1, 1
      )
    `, [new Date(`${oldPollDate}T12:00:00Z`), digest('old-poll', oldPollDate)]);
    await assert.rejects(
      pool.query(
        "SELECT operations.drop_retention_partition('poll_run', $1::date, $2::timestamptz, 'aggregate-v2')",
        [oldPollDate, asOf],
      ),
      /coverage_summary_missing_or_stale|authorization_missing/u,
    );
    await pool.query('SELECT operations.summarize_operations_date($1::date)', [oldPollDate]);
    await pool.query(
      "SELECT operations.authorize_retention_partition('poll_run', $1::date, $2::timestamptz, 'aggregate-v2')",
      [oldPollDate, asOf],
    );
    const pollDrop = await callReport(
      pool,
      "SELECT operations.drop_retention_partition('poll_run', $1::date, $2::timestamptz, 'aggregate-v2') AS report",
      [oldPollDate, asOf],
    );
    assert.equal(pollDrop.status, 'dropped');
    assert.equal(pollDrop.droppedRows, 1);
    const pollPartitions = await pool.query<{ dropped: string | null; neighbor: string | null }>(`
      SELECT to_regclass('ingest.poll_run_' || to_char($1::date, 'YYYYMMDD'))::text AS dropped,
        to_regclass('ingest.poll_run_' || to_char($2::date, 'YYYYMMDD'))::text AS neighbor
    `, [oldPollDate, oldPollNext]);
    assert.deepEqual(pollPartitions.rows[0], { dropped: null, neighbor: `ingest.poll_run_${neighborSuffix}` });

    const permissions = await pool.query<{
      analytics_insert: boolean; ledger_insert: boolean; retention_execute: boolean;
      internal_finalize_execute: boolean; internal_seal_execute: boolean; guarded_seal_execute: boolean;
    }>(`
      SELECT has_table_privilege(current_user, 'analytics.daily_line_summary', 'INSERT') AS analytics_insert,
        has_table_privilege(current_user, 'operations.retention_ledger', 'INSERT') AS ledger_insert,
        has_function_privilege(current_user, 'operations.drop_retention_partition(text,date,timestamptz,text)', 'EXECUTE') AS retention_execute,
        has_function_privilege(current_user, 'operations.finalize_service_day_from_canonical(date,text,timestamptz,integer)', 'EXECUTE') AS internal_finalize_execute,
        has_function_privilege(current_user, 'operations.seal_month_from_verified_contributions(date,text,timestamptz,integer)', 'EXECUTE') AS internal_seal_execute,
        has_function_privilege(current_user, 'operations.seal_month(date,text,timestamptz,integer)', 'EXECUTE') AS guarded_seal_execute
    `);
    assert.deepEqual(permissions.rows[0], {
      analytics_insert: false,
      ledger_insert: false,
      retention_execute: true,
      internal_finalize_execute: false,
      internal_seal_execute: false,
      guarded_seal_execute: true,
    });
    const roleBoundaries = await databaseAdmin.query<{
      web_select: boolean; backup_select: boolean; monitor_health: boolean; monitor_aggregate_select: boolean;
    }>(`
      SELECT has_table_privilege('atodotren_web_reader', 'analytics.daily_line_summary', 'SELECT') AS web_select,
        has_table_privilege('atodotren_backup_reader', 'analytics.daily_line_summary', 'SELECT') AS backup_select,
        has_table_privilege('atodotren_monitor_reader', 'operations.aggregation_health', 'SELECT') AS monitor_health,
        has_table_privilege('atodotren_monitor_reader', 'analytics.daily_line_summary', 'SELECT') AS monitor_aggregate_select
    `);
    assert.deepEqual(roleBoundaries.rows[0], {
      web_select: false,
      backup_select: true,
      monitor_health: true,
      monitor_aggregate_select: false,
    });

    await databaseAdmin.query(`
      INSERT INTO analytics.daily_line_summary
      SELECT (jsonb_populate_record(
        NULL::analytics.daily_line_summary,
        to_jsonb(source_row) || jsonb_build_object('service_date', day_value::date)
      )).*
      FROM analytics.daily_line_summary AS source_row
      CROSS JOIN generate_series(date '2018-01-01', date '2022-12-31', interval '1 day') AS day_value
      WHERE source_row.service_date = $1::date
        AND source_row.aggregate_algorithm_version = 'aggregate-v2'
    `, [targetDate]);
    await databaseAdmin.query('ANALYZE analytics.daily_line_summary');
    const benchmarkLine = await databaseAdmin.query<{ line_id: string }>(`
      SELECT line_id::text FROM analytics.daily_line_summary
      WHERE service_date = date '2018-01-01' LIMIT 1
    `);
    const lineId = benchmarkLine.rows[0]?.line_id;
    assert.ok(lineId !== undefined);
    const explain = await databaseAdmin.query<{ 'QUERY PLAN': string }>(`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT service_date, scheduled_opportunities, punctual_count, source_coverage
      FROM analytics.daily_line_summary
      WHERE line_id = $1::bigint
        AND service_date >= date '2021-06-01' AND service_date < date '2021-07-01'
      ORDER BY service_date
    `, [lineId]);
    const planText = explain.rows.map((row) => row['QUERY PLAN']).join('\n');
    assert.match(planText, /daily_line_summary_range_idx/u);
    const storage = await databaseAdmin.query<{
      synthetic_days: string; total_bytes: string; index_bytes: string;
    }>(`
      SELECT
        (SELECT count(DISTINCT service_date) FROM analytics.daily_line_summary
          WHERE service_date >= date '2018-01-01' AND service_date <= date '2022-12-31')::text AS synthetic_days,
        pg_total_relation_size('analytics.daily_line_summary')::text AS total_bytes,
        pg_indexes_size('analytics.daily_line_summary')::text AS index_bytes
    `);
    assert.equal(storage.rows[0]?.synthetic_days, '1826');
    assert.ok(Number(storage.rows[0]?.total_bytes) > 0);
    assert.ok(Number(storage.rows[0]?.index_bytes) > 0);

    console.log(JSON.stringify({
      milestone4Acceptance: {
        targetDate,
        stopOpportunities: 31,
        journeyOpportunities: 4,
        segmentOpportunities: 27,
        canonicalDroppedRows: canonicalDrop.droppedRows,
        pollDroppedRows: pollDrop.droppedRows,
        deterministicChecksum,
        sealedV1Checksum,
        sealedV2Checksum: sealedV2.checksum,
        syntheticDays: Number(storage.rows[0]?.synthetic_days),
        totalBytes: Number(storage.rows[0]?.total_bytes),
        indexBytes: Number(storage.rows[0]?.index_bytes),
        queryPlan: planText,
      },
    }));
  } finally {
    await pool?.end().catch(() => undefined);
    await databaseAdmin?.end().catch(() => undefined);
    await clusterAdmin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [databaseName],
    ).catch(() => undefined);
    await clusterAdmin.query(`DROP DATABASE IF EXISTS ${databaseName}`).catch(() => undefined);
    await clusterAdmin.end();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
