import {
  MAX_INCIDENTS,
  MAX_TRAINS,
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
  const [ingestion, canonical, finalization, staticFeed, incidents] = await Promise.all([
    pool.query('SELECT * FROM operations.report_ingest_health LIMIT 1'),
    pool.query('SELECT * FROM operations.report_canonical_health LIMIT 1'),
    pool.query('SELECT * FROM operations.report_finalization ORDER BY service_date DESC, finalized_at DESC LIMIT 1'),
    pool.query('SELECT * FROM operations.report_static_age ORDER BY network_id LIMIT 1'),
    pool.query("SELECT count(*)::int AS count FROM operations.report_incident_episode WHERE is_open"),
  ]);
  return {
    ...reportBase(now), kind: 'status', source: 'operational_views', precision: 'operational snapshot',
    ingestion: (ingestion.rows[0] as Readonly<Record<string, unknown>> | undefined) ?? null,
    canonical: (canonical.rows[0] as Readonly<Record<string, unknown>> | undefined) ?? null,
    latestFinalization: (finalization.rows[0] as Readonly<Record<string, unknown>> | undefined) ?? null,
    staticFeed: (staticFeed.rows[0] as Readonly<Record<string, unknown>> | undefined) ?? null,
    openIncidents: numberValue(incidents.rows[0]?.count),
  };
}

export async function incidentsReport(reporting: ReportingService): Promise<IncidentsReport> {
  const now = reporting.now();
  const result = await reporting.pool.query(`SELECT * FROM operations.report_incident_episode
    WHERE is_open OR recovered_at >= clock_timestamp() - interval '48 hours'
    ORDER BY is_open DESC, last_observed_at DESC LIMIT ${MAX_INCIDENTS}`);
  return {
    ...reportBase(now), kind: 'incidents', source: 'ingestion_incident_facts', precision: 'episode facts',
    incidents: result.rows as readonly Readonly<Record<string, unknown>>[],
  };
}

export async function trainsReport(reporting: ReportingService, lineId: number): Promise<TrainsReport | null> {
  if (!Number.isSafeInteger(lineId) || lineId <= 0) throw new RangeError('lineId must be a positive integer');
  const now = reporting.now();
  const line = await reporting.pool.query('SELECT line_id, public_code, name_es FROM operations.report_line_lookup WHERE line_id = $1 LIMIT 1', [lineId]);
  const lineRow = line.rows[0];
  if (lineRow === undefined) return null;
  const result = await reporting.pool.query(`SELECT * FROM operations.report_vehicle_live
    WHERE line_id = $1 AND captured_at >= clock_timestamp() - interval '30 minutes'
    ORDER BY captured_at DESC LIMIT ${MAX_TRAINS}`, [lineId]);
  return {
    ...reportBase(now), kind: 'trains', source: 'live_vehicle_state', precision: 'latest canonicalized live state',
    line: { id: lineId, name: String(lineRow.name_es), code: String(lineRow.public_code) },
    trains: result.rows.map((row) => ({
      trainId: row.journey_id === null || row.service_date === null
        ? `live:${String(row.state_key)}`
        : `${dateText(row.service_date as string | Date)}:${String(row.journey_id)}`,
      sourceTripId: String(row.source_trip_id),
      vehicleId: row.vehicle_id === null ? null : String(row.vehicle_id),
      capturedAt: instantText(row.captured_at) ?? '',
      station: row.current_station_name_es === null ? null : String(row.current_station_name_es),
      status: String(row.current_status),
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
    const result = await reporting.pool.query(
      'SELECT * FROM operations.report_journey_recent WHERE service_date = $1::date AND journey_id = $2::bigint LIMIT 1',
      [match[1], match[2]],
    );
    row = result.rows[0] as Readonly<Record<string, unknown>> | undefined;
  } else if (trainId.startsWith('live:') && trainId.length <= 110) {
    const result = await reporting.pool.query('SELECT * FROM operations.report_vehicle_live WHERE state_key = $1 LIMIT 1', [trainId.slice(5)]);
    row = result.rows[0] as Readonly<Record<string, unknown>> | undefined;
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
  const [coverage, size] = await Promise.all([
    reporting.pool.query(`SELECT min(service_date)::text AS first_date, max(service_date)::text AS last_date,
      count(DISTINCT service_date)::int AS service_days, sum(poll_count)::bigint AS polls,
      sum(successful_poll_count)::bigint AS successful_polls, sum(matched_madrid_count)::bigint AS matched_madrid,
      sum(response_bytes)::bigint AS response_bytes
      FROM operations.report_feed_coverage`),
    reporting.pool.query('SELECT * FROM operations.report_database_size LIMIT 1'),
  ]);
  const row = coverage.rows[0] ?? {};
  const databaseBytes = nullableNumber(size.rows[0]?.database_bytes);
  const serviceDays = numberValue(row.service_days);
  return {
    ...reportBase(now), kind: 'pilot', source: 'finalized_feed_coverage+database_size', precision: 'bounded aggregate',
    startedServiceDate: row.first_date === null || row.first_date === undefined ? null : String(row.first_date),
    latestServiceDate: row.last_date === null || row.last_date === undefined ? null : String(row.last_date),
    serviceDays,
    polls: numberValue(row.polls), successfulPolls: numberValue(row.successful_polls), matchedMadrid: numberValue(row.matched_madrid),
    responseBytes: numberValue(row.response_bytes), databaseBytes,
    projectedDatabaseBytes14Days: databaseBytes !== null && serviceDays > 0 ? Math.round(databaseBytes / serviceDays * 14) : null,
  };
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
  if (report.kind === 'status') return `Status ${report.generatedAt}\nOpen incidents: ${report.openIncidents}\nIngestion: ${JSON.stringify(report.ingestion)}\nCanonical: ${JSON.stringify(report.canonical)}\nFinalization: ${JSON.stringify(report.latestFinalization)}`;
  if (report.kind === 'incidents') return report.incidents.length === 0
    ? 'No open or recent incident episodes.'
    : report.incidents.map((incident) => `${String(incident.incident_key)} · ${incident.is_open === true ? 'ACTIVE' : 'RECOVERED'} · count ${String(incident.occurrence_count)}`).join('\n');
  if (report.kind === 'trains') return `${report.line.code} active trains (${report.trains.length}/${MAX_TRAINS} max)\n${report.trains.map((train) => `${train.trainId} · ${train.station ?? 'station n/a'} · ${train.delaySeconds ?? 'n/a'}s`).join('\n')}`;
  if (report.kind === 'train') return report.journey === null ? `Train ${report.trainId}: no current/recent canonical state.` : `Train ${report.trainId}\n${JSON.stringify(report.journey)}`;
  return `Pilot: ${report.startedServiceDate ?? 'n/a'} → ${report.latestServiceDate ?? 'n/a'} (${report.serviceDays} service days)\nPolls ${report.polls}, successful ${report.successfulPolls}, matched Madrid ${report.matchedMadrid}, response bytes ${report.responseBytes}\nDB ${report.databaseBytes ?? 'n/a'} bytes; 14-day projection ${report.projectedDatabaseBytes14Days ?? 'n/a'} bytes`;
}
