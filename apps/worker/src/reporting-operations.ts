import {
  MAX_INCIDENTS,
  MAX_TRAINS,
  currentMadridServiceDate,
  dateText,
  instantText,
  nullableNumber,
  numberValue,
  parseReportDate,
  reportBase,
  type IncidentsReport,
  type PilotReport,
  type ReportResult,
  type StatusReport,
  type TrainReport,
  type TrainsReport,
} from './reporting-core.js';
import type { ReportingService } from './reporting-service.js';

export async function statusReport(reporting: ReportingService): Promise<StatusReport> {
  const now = reporting.now();
  const pool = reporting.pool;
  const [ingestion, canonical, finalization, staticFeed, incidents, monitors] = await Promise.all([
    pool.query<Record<string, unknown>>('SELECT * FROM operations.report_ingest_health LIMIT 1'),
    pool.query<Record<string, unknown>>('SELECT * FROM operations.report_canonical_health LIMIT 1'),
    pool.query<Record<string, unknown>>('SELECT * FROM operations.report_finalization ORDER BY service_date DESC, finalized_at DESC LIMIT 1'),
    pool.query<Record<string, unknown>>('SELECT * FROM operations.report_static_age ORDER BY network_id LIMIT 1'),
    pool.query<Record<string, unknown>>("SELECT count(*)::int AS count FROM operations.report_incident_episode WHERE is_open"),
    pool.query<Record<string, unknown>>(`SELECT monitor_key, opened_at, last_observed_at, consecutive_count
      FROM operations.telegram_monitor_episode WHERE is_open ORDER BY opened_at LIMIT 20`),
  ]);
  return {
    ...reportBase(now), kind: 'status', source: 'operational_views', precision: 'operational snapshot',
    ingestion: ingestion.rows[0] ?? null,
    canonical: canonical.rows[0] ?? null,
    latestFinalization: finalization.rows[0] ?? null,
    staticFeed: staticFeed.rows[0] ?? null,
    openIncidents: numberValue(incidents.rows[0]?.count),
    openMonitorEpisodes: monitors.rows,
  };
}

export async function incidentsReport(reporting: ReportingService): Promise<IncidentsReport> {
  const now = reporting.now();
  const result = await reporting.pool.query<Record<string, unknown>>(`SELECT * FROM operations.report_incident_episode
    WHERE is_open OR recovered_at >= clock_timestamp() - interval '48 hours'
    ORDER BY is_open DESC, last_observed_at DESC LIMIT ${MAX_INCIDENTS}`);
  return {
    ...reportBase(now), kind: 'incidents', source: 'ingestion_incident_facts', precision: 'episode facts',
    incidents: result.rows,
  };
}

export async function trainsReport(reporting: ReportingService, lineId: number): Promise<TrainsReport | null> {
  if (!Number.isSafeInteger(lineId) || lineId <= 0) throw new RangeError('lineId must be a positive integer');
  const now = reporting.now();
  const line = await reporting.pool.query<Record<string, unknown>>('SELECT line_id, public_code, name_es FROM operations.report_line_lookup WHERE line_id = $1 LIMIT 1', [lineId]);
  const lineRow = line.rows[0];
  if (lineRow === undefined) return null;
  const result = await reporting.pool.query<Record<string, unknown>>(`SELECT * FROM operations.report_vehicle_live
    WHERE line_id = $1 AND captured_at >= clock_timestamp() - interval '30 minutes'
    ORDER BY captured_at DESC LIMIT ${MAX_TRAINS}`, [lineId]);
  return {
    ...reportBase(now), kind: 'trains', source: 'live_vehicle_state', precision: 'latest canonicalized live state',
    line: { id: lineId, name: displayScalar(lineRow.name_es), code: displayScalar(lineRow.public_code) },
    trains: result.rows.map((row) => ({
      trainId: row.journey_id === null || row.service_date === null
        ? `live:${displayScalar(row.state_key)}`
        : `${dateText(row.service_date as string | Date)}:${displayScalar(row.journey_id)}`,
      sourceTripId: displayScalar(row.source_trip_id),
      vehicleId: row.vehicle_id === null ? null : displayScalar(row.vehicle_id),
      capturedAt: instantText(row.captured_at) ?? '',
      station: row.current_station_name_es === null ? null : displayScalar(row.current_station_name_es),
      status: displayScalar(row.current_status),
      delaySeconds: nullableNumber(row.latest_stop_delay),
    })),
  };
}

export async function trainReport(reporting: ReportingService, trainId: string): Promise<TrainReport> {
  const now = reporting.now();
  const match = /^(\d{4}-\d{2}-\d{2}):(\d{1,18})$/u.exec(trainId);
  let row: Readonly<Record<string, unknown>> | undefined;
  if (match !== null) {
    parseReportDate(match[1], now);
    const result = await reporting.pool.query<Record<string, unknown>>(
      'SELECT * FROM operations.report_journey_recent WHERE service_date = $1::date AND journey_id = $2::bigint LIMIT 1',
      [match[1], match[2]],
    );
    row = result.rows[0];
  } else if (trainId.startsWith('live:') && trainId.length <= 110) {
    const result = await reporting.pool.query<Record<string, unknown>>('SELECT * FROM operations.report_vehicle_live WHERE state_key = $1 LIMIT 1', [trainId.slice(5)]);
    row = result.rows[0];
  } else {
    throw new RangeError('Train id must be the bounded id returned by /trains');
  }
  return {
    ...reportBase(now), kind: 'train', trainId,
    source: 'canonical_journey_or_live_state', precision: 'current/recent exact state', journey: row ?? null,
  };
}

export async function pilotReport(reporting: ReportingService): Promise<PilotReport> {
  const now = reporting.now();
  const [coverage, size, sampleResult] = await Promise.all([
    reporting.pool.query<Record<string, unknown>>(`SELECT min(service_date)::text AS first_date, max(service_date)::text AS last_date,
      count(DISTINCT service_date)::int AS service_days, sum(poll_count)::bigint AS polls,
      sum(successful_poll_count)::bigint AS successful_polls, sum(matched_madrid_count)::bigint AS matched_madrid,
      sum(response_bytes)::bigint AS response_bytes
      FROM operations.report_feed_coverage`),
    reporting.pool.query<Record<string, unknown>>('SELECT * FROM operations.report_database_size LIMIT 1'),
    reporting.pool.query<Record<string, unknown>>(`SELECT sampled_at, database_bytes
      FROM operations.telegram_resource_sample
      WHERE database_bytes IS NOT NULL
      ORDER BY sampled_at DESC LIMIT 720`),
  ]);
  const row = coverage.rows[0] ?? {};
  const databaseBytes = nullableNumber(size.rows[0]?.database_bytes);
  const serviceDays = numberValue(row.service_days);
  const growth = measuredGrowth(sampleResult.rows);
  return {
    ...reportBase(now), kind: 'pilot', source: 'finalized_feed_coverage+database_size+resource_samples', precision: 'bounded aggregate and hourly numeric samples',
    startedServiceDate: row.first_date === null || row.first_date === undefined ? null : displayScalar(row.first_date),
    latestServiceDate: row.last_date === null || row.last_date === undefined ? null : displayScalar(row.last_date),
    serviceDays,
    polls: numberValue(row.polls), successfulPolls: numberValue(row.successful_polls), matchedMadrid: numberValue(row.matched_madrid),
    responseBytes: numberValue(row.response_bytes), databaseBytes,
    measuredDatabaseGrowthBytes: growth.deltaBytes,
    measuredGrowthHours: growth.hours,
    projectedVariableGrowth14DaysBytes: growth.projected14DaysBytes,
  };
}

function measuredGrowth(rows: readonly Readonly<Record<string, unknown>>[]): {
  readonly deltaBytes: number | null;
  readonly hours: number | null;
  readonly projected14DaysBytes: number | null;
} {
  const latestRow = rows[0];
  if (latestRow === undefined) return { deltaBytes: null, hours: null, projected14DaysBytes: null };
  const latestAt = dateValue(latestRow.sampled_at);
  const latestBytes = nullableNumber(latestRow.database_bytes);
  if (latestAt === null || latestBytes === null) return { deltaBytes: null, hours: null, projected14DaysBytes: null };
  const latestServiceDate = currentMadridServiceDate(latestAt);
  const baseline = rows.slice(1).find((candidate) => {
    const sampledAt = dateValue(candidate.sampled_at);
    const bytes = nullableNumber(candidate.database_bytes);
    return sampledAt !== null
      && bytes !== null
      && latestAt.getTime() - sampledAt.getTime() >= 6 * 3_600_000
      && currentMadridServiceDate(sampledAt) !== latestServiceDate;
  });
  if (baseline === undefined) return { deltaBytes: null, hours: null, projected14DaysBytes: null };
  const baselineAt = dateValue(baseline.sampled_at);
  const baselineBytes = nullableNumber(baseline.database_bytes);
  if (baselineAt === null || baselineBytes === null) return { deltaBytes: null, hours: null, projected14DaysBytes: null };
  const elapsedMs = latestAt.getTime() - baselineAt.getTime();
  if (elapsedMs <= 0) return { deltaBytes: null, hours: null, projected14DaysBytes: null };
  const deltaBytes = latestBytes - baselineBytes;
  const projected = deltaBytes < 0 ? null : Math.round(deltaBytes / elapsedMs * 14 * 86_400_000);
  return { deltaBytes, hours: elapsedMs / 3_600_000, projected14DaysBytes: projected };
}

function dateValue(value: unknown): Date | null {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return parsed === null || Number.isNaN(parsed.getTime()) ? null : parsed;
}

function displayScalar(value: unknown): string {
  if (value === null || value === undefined) return 'n/a';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  return 'unavailable';
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function seconds(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)}s`;
}

function metricText(report: Extract<ReportResult, { metrics: unknown }>): string {
  const metrics = report.metrics;
  return [
    `scheduled stops ${metrics.scheduledStopOpportunities}`,
    `usable ${metrics.usableObservations} (${percent(metrics.coverage)} coverage)`,
    `punctual <=120s ${percent(metrics.punctuality)}`,
    `avg ${seconds(metrics.averageArrivalDelaySeconds)}`,
    `median ~${seconds(metrics.medianArrivalDelaySeconds)}`,
    `canceled ${metrics.canceled} (${percent(metrics.canceledRate)})`,
    `missing ${metrics.missingEvidence} (${percent(metrics.missingEvidenceRate)})`,
  ].join(' · ');
}

export function formatReportText(report: ReportResult): string {
  if (report.kind === 'daily') {
    const worstLine = report.worstLine === null ? 'n/a' : `${report.worstLine.code} ${percent(report.worstLine.punctuality)} (n=${report.worstLine.sampleSize})`;
    const worstStation = report.worstStation === null ? 'n/a' : `${report.worstStation.name} ${percent(report.worstStation.punctuality)} (n=${report.worstStation.sampleSize})`;
    return `Daily ${report.serviceDate} [${report.finalization.status}]\n${metricText(report)}\nWorst line: ${worstLine} · Worst station: ${worstStation}\nSource: ${report.source}; precision: ${report.precision}; timezone: ${report.timezone}`;
  }
  if (report.kind === 'line') return `${report.line.code} — ${report.serviceDate}\n${metricText(report)}\nSource: ${report.source}; precision: ${report.precision}`;
  if (report.kind === 'station') return `${report.station.name} — ${report.serviceDate}\n${metricText(report)}\nSource: ${report.source}; precision: ${report.precision}`;
  if (report.kind === 'status') {
    const monitors = report.openMonitorEpisodes.length === 0
      ? 'none'
      : report.openMonitorEpisodes.map((episode) => String(episode.monitor_key)).join(', ');
    return `Status ${report.generatedAt}\nOpen ingestion incidents: ${report.openIncidents}\nOpen bot monitor episodes: ${monitors}\nIngestion: ${JSON.stringify(report.ingestion)}\nCanonical: ${JSON.stringify(report.canonical)}\nFinalization: ${JSON.stringify(report.latestFinalization)}`;
  }
  if (report.kind === 'incidents') return report.incidents.length === 0
    ? 'No open or recent incident episodes.'
    : report.incidents.map((incident) => `${String(incident.incident_key)} · ${incident.is_open === true ? 'ACTIVE' : 'RECOVERED'} · count ${String(incident.occurrence_count)}`).join('\n');
  if (report.kind === 'trains') return `${report.line.code} active trains (${report.trains.length}/${MAX_TRAINS} max)\n${report.trains.map((train) => `${train.trainId} · ${train.station ?? 'station n/a'} · ${train.delaySeconds ?? 'n/a'}s`).join('\n')}`;
  if (report.kind === 'train') return report.journey === null ? `Train ${report.trainId}: no current/recent canonical state.` : `Train ${report.trainId}\n${JSON.stringify(report.journey)}`;
  const measured = report.measuredDatabaseGrowthBytes === null || report.measuredGrowthHours === null
    ? 'measured growth unavailable'
    : `measured growth ${report.measuredDatabaseGrowthBytes >= 0 ? '+' : ''}${report.measuredDatabaseGrowthBytes} B over ${report.measuredGrowthHours.toFixed(1)}h`;
  const projected = report.projectedVariableGrowth14DaysBytes === null
    ? 'projection unavailable'
    : `projected variable growth (14d) +${report.projectedVariableGrowth14DaysBytes} B`;
  return `Pilot: ${report.startedServiceDate ?? 'n/a'} → ${report.latestServiceDate ?? 'n/a'} (${report.serviceDays} service days)\nPolls ${report.polls}, successful ${report.successfulPolls}, matched Madrid ${report.matchedMadrid}, response bytes ${report.responseBytes}\nStorage: current total ${report.databaseBytes ?? 'unavailable'} B; ${measured}; ${projected}. Projection excludes future static-feed and index changes.`;
}
