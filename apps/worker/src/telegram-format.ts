import { MAX_TRAINS, type MetricSummary, type ReportResult } from './reporting-core.js';
import {
  formatBytes,
  formatRatio,
  measurementValue,
  preferredMeasurement,
  type ResourceSample,
} from './resources.js';

const madridDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid', day: '2-digit', month: 'short', year: 'numeric',
});
const madridTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const madridDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function escapeTelegramHtml(value: unknown): string {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function formatTelegramInstant(value: unknown): string {
  return formatInstant(value);
}

export function compactCercaniasCode(value: string): string {
  const match = /^c[\s-]*(\d+[a-z]?)$/iu.exec(value.trim());
  return match === null ? value : `C${match[1] ?? ''}`;
}

export function formatTelegramReport(report: ReportResult): string {
  if (report.kind === 'daily' || report.kind === 'line' || report.kind === 'station') {
    const title = report.kind === 'daily'
      ? `🚆 Madrid Cercanías · ${formatServiceDate(report.serviceDate)}`
      : report.kind === 'line'
        ? `🚆 ${escapeTelegramHtml(compactCercaniasCode(report.line.code))} · ${formatServiceDate(report.serviceDate)}`
        : `🚉 ${escapeTelegramHtml(report.station.name)} · ${formatServiceDate(report.serviceDate)}`;
    const state = report.kind === 'daily'
      ? report.finalization.status === 'verified' ? '✅ Verified daily aggregate' : '⏳ Live aggregate · not finalized'
      : '⏳ Daily aggregate';
    const sections = [titleLine(title), `<i>${state}</i>`, '', formatMetrics(report.metrics)];
    if (report.kind === 'daily') sections.push('', formatRankings(report));
    sections.push('', `<i>Stop-call metrics · punctual means ≤2 min · median is approximate</i>`);
    return sections.join('\n');
  }
  if (report.kind === 'status') return formatStatus(report);
  if (report.kind === 'incidents') return formatIncidents(report);
  if (report.kind === 'trains') return formatTrains(report);
  if (report.kind === 'train') return formatTrain(report);
  return formatPilot(report);
}

export function formatTelegramResources(sample: ResourceSample, trend: readonly ResourceSample[]): string {
  const firstDatabase = trend[0] === undefined ? null : measurementValue(trend[0].databaseBytes);
  const currentDatabase = measurementValue(sample.databaseBytes);
  const delta = firstDatabase === null || currentDatabase === null ? null : currentDatabase - firstDatabase;
  const cpu = preferredMeasurement(sample.hostCpuRatio, sample.telegramProcessCpuRatio);
  const memory = preferredMeasurement(sample.hostMemoryRatio, sample.telegramContainerMemoryRatio);
  const disk = preferredMeasurement(sample.hostDiskFreeRatio, sample.spoolFreeRatio);
  return [
    titleLine('🖥 System resources'),
    `<i>Snapshot ${formatInstant(sample.generatedAt)}</i>`,
    '',
    '<b>Host / service</b>',
    `${ratioSignal(measurementValue(cpu), 0.75, 0.9, false)} CPU: <b>${escapeTelegramHtml(formatRatio(cpu))}</b>`,
    `${ratioSignal(measurementValue(memory), 0.7, 0.85, false)} Memory: <b>${escapeTelegramHtml(formatRatio(memory))}</b> · bot RSS ${escapeTelegramHtml(formatBytes(sample.telegramProcessRssBytes))}`,
    `${ratioSignal(measurementValue(disk), 0.15, 0.08, true)} Disk free: <b>${escapeTelegramHtml(formatRatio(disk))}</b>`,
    '',
    '<b>Storage</b>',
    `🗄 Database: <b>${escapeTelegramHtml(formatBytes(sample.databaseBytes))}</b>${delta === null ? '' : ` · trend ${escapeTelegramHtml(formatSignedBytes(delta))}`}`,
    `📦 Realtime spool: <b>${escapeTelegramHtml(formatBytes(sample.spoolBytes))}</b>`,
  ].join('\n');
}

export function formatTelegramIncident(options: {
  readonly active: boolean;
  readonly key: string;
  readonly openedAt: Date | string;
  readonly recoveredAt?: Date | string | null;
  readonly observations?: number | string;
  readonly detail?: string;
}): string {
  const heading = options.active ? '🔴 <b>ACTIVE INCIDENT</b>' : '🟢 <b>RECOVERED</b>';
  const lines = [heading, `<b>${escapeTelegramHtml(humanKey(options.key))}</b>`, '', `Opened: <b>${formatInstant(options.openedAt)}</b>`];
  if (options.active && options.observations !== undefined) lines.push(`Confirmed observations: <b>${escapeTelegramHtml(options.observations)}</b>`);
  if (!options.active && options.recoveredAt !== undefined) lines.push(`Recovered: <b>${formatInstant(options.recoveredAt)}</b>`);
  if (options.detail !== undefined) lines.push('', escapeTelegramHtml(options.detail));
  lines.push('', '<i>Use /status or /incidents for more detail.</i>');
  return lines.join('\n');
}

export function telegramHelpText(): string {
  return [
    titleLine('🚆 Atodotren operations bot'),
    '<i>Private, read-only pilot monitoring</i>',
    '',
    '<b>Overview</b>',
    '/status · current system state',
    '/daily [date] · daily performance',
    '/pilot · pilot coverage and storage',
    '/resources · CPU, memory, disk and database',
    '/incidents · open and recent episodes',
    '',
    '<b>Explore Cercanías</b>',
    '/line &lt;name&gt; [date]',
    '/station &lt;name&gt; [date]',
    '/trains &lt;line&gt;',
    '/train &lt;id&gt;',
    '',
    '<i>Examples: /daily yesterday · /line C1 2026-08-22 · /station Atocha · /trains C1</i>',
  ].join('\n');
}

function formatMetrics(metrics: MetricSummary): string {
  return [
    '<b>Reliability</b>',
    `${metricSignal(metrics.punctuality, 0.8, 0.5)} Punctual within 2 min: <b>${percent(metrics.punctuality)}</b>`,
    `${delaySignal(metrics.averageArrivalDelaySeconds)} Average delay: <b>${duration(metrics.averageArrivalDelaySeconds)}</b>`,
    `${delaySignal(metrics.medianArrivalDelaySeconds)} Median delay: <b>~${duration(metrics.medianArrivalDelaySeconds)}</b>`,
    '',
    '<b>Evidence</b>',
    `${metricSignal(metrics.coverage, 0.8, 0.6)} Coverage: <b>${percent(metrics.coverage)}</b> · ${metrics.usableObservations.toLocaleString('en-GB')} / ${metrics.scheduledStopOpportunities.toLocaleString('en-GB')} stop calls`,
    `❌ Canceled stop calls: <b>${metrics.canceled.toLocaleString('en-GB')}</b> · ${percent(metrics.canceledRate)}`,
    `❓ Missing evidence: <b>${metrics.missingEvidence.toLocaleString('en-GB')}</b> · ${percent(metrics.missingEvidenceRate)}`,
  ].join('\n');
}

function formatRankings(report: Extract<ReportResult, { kind: 'daily' }>): string {
  const line = report.worstLine === null
    ? 'Not enough evidence'
    : `${escapeTelegramHtml(compactCercaniasCode(report.worstLine.code))} · <b>${percent(report.worstLine.punctuality)}</b> punctual · n=${report.worstLine.sampleSize}`;
  const station = report.worstStation === null
    ? 'Not enough evidence'
    : `${escapeTelegramHtml(report.worstStation.name)} · <b>${percent(report.worstStation.punctuality)}</b> punctual · n=${report.worstStation.sampleSize}`;
  return `<b>Lowest punctuality (minimum sample applied)</b>\n🔻 Line: ${line}\n🔻 Station: ${station}`;
}

function formatStatus(report: Extract<ReportResult, { kind: 'status' }>): string {
  const ingestion = report.ingestion;
  const canonical = report.canonical;
  const finalization = report.latestFinalization;
  const feed = report.staticFeed;
  const monitorNames = report.openMonitorEpisodes.map((value) => humanKey(read(value, 'monitor_key')));
  const overallGood = report.openIncidents === 0 && monitorNames.length === 0;
  return [
    titleLine(`${overallGood ? '🟢' : '🟠'} System status`),
    `<i>${formatInstant(report.generatedAt)}</i>`,
    '',
    '<b>Ingestion</b>',
    `${overallGood ? '🟢' : '🟠'} Open incidents: <b>${report.openIncidents}</b> · bot monitors: <b>${monitorNames.length}</b>`,
    `Latest durable cycle: <b>${formatInstant(read(ingestion, 'last_durable_cycle_at'))}</b>`,
    `Latest successful poll: <b>${formatInstant(read(ingestion, 'latest_successful_poll_at'))}</b>`,
    `Fresh vehicles: <b>${formatInteger(read(ingestion, 'fresh_vehicle_count'))}</b> · retained states ${formatInteger(read(ingestion, 'live_vehicle_count'))}`,
    `Spool: <b>${formatInteger(read(ingestion, 'spool_pending_count'))} pending</b> · ${formatBytesValue(read(ingestion, 'spool_bytes'))}`,
    `Unresolved evidence: <b>${formatInteger(read(ingestion, 'unresolved_evidence_count'))}</b>`,
    '',
    '<b>Canonical journeys</b>',
    `Open: <b>${formatInteger(read(canonical, 'open_journeys'))}</b> · closed ${formatInteger(read(canonical, 'closed_journeys'))}`,
    `Latest update: <b>${formatInstant(read(canonical, 'latest_canonical_update_at'))}</b>`,
    '',
    '<b>Finalization</b>',
    finalization === null
      ? '⚪ No finalized service day yet'
      : `${read(finalization, 'status') === 'verified' ? '✅' : '🟠'} ${formatServiceDate(read(finalization, 'service_date'))} · <b>${escapeTelegramHtml(read(finalization, 'status'))}</b> · ${formatInteger(read(finalization, 'source_journey_count'))} journeys`,
    '',
    '<b>Static timetable</b>',
    `Latest fetch: <b>${formatInstant(read(feed, 'active_fetched_at'))}</b>`,
    ...(monitorNames.length === 0 ? [] : ['', `<b>Open monitors</b>\n${monitorNames.map((name) => `• ${escapeTelegramHtml(name)}`).join('\n')}`]),
  ].join('\n');
}

function formatIncidents(report: Extract<ReportResult, { kind: 'incidents' }>): string {
  if (report.incidents.length === 0) return `${titleLine('🟢 Incidents')}\n\nNo open or recent incident episodes.`;
  const entries = report.incidents.map((incident) => {
    const active = incident.is_open === true;
    return [
      `${active ? '🔴' : '🟢'} <b>${escapeTelegramHtml(humanKey(read(incident, 'incident_key')))}</b> · ${active ? 'ACTIVE' : 'recovered'}`,
      `   ${formatInstant(read(incident, 'last_observed_at'))} · ${formatInteger(read(incident, 'occurrence_count'))} observations`,
    ].join('\n');
  });
  return `${titleLine('🚨 Incident episodes')}\n<i>Open and recovered within 48 hours</i>\n\n${entries.join('\n\n')}`;
}

function formatTrains(report: Extract<ReportResult, { kind: 'trains' }>): string {
  const rows = report.trains.map((train) => {
    const location = vehicleLocation(train.status, train.station);
    return `• <code>${escapeTelegramHtml(train.trainId)}</code> · ${location}\n  ${delaySignal(train.delaySeconds)} Delay: <b>${duration(train.delaySeconds)}</b> · updated ${formatTime(train.capturedAt)}`;
  });
  return [
    titleLine(`🚆 ${escapeTelegramHtml(compactCercaniasCode(report.line.code))} · live trains`),
    `<i>${report.trains.length} fresh states · showing up to ${MAX_TRAINS}</i>`,
    '',
    ...rows,
    '',
    '<i>Stops are the next or associated Renfe stop, not GPS positions. Tap a train below for details.</i>',
  ].join('\n');
}

function formatTrain(report: Extract<ReportResult, { kind: 'train' }>): string {
  if (report.journey === null) return `${titleLine('🚆 Train details')}\n\nNo current or recent canonical state for <code>${escapeTelegramHtml(report.trainId)}</code>.`;
  const row = report.journey;
  const code = read(row, 'public_code');
  const displayCode = typeof code === 'string' ? compactCercaniasCode(code) : 'Train';
  const destination = read(row, 'final_station_name_es');
  const associatedStop = read(row, 'current_station_name_es');
  const delay = numeric(read(row, 'final_delay_seconds') ?? read(row, 'latest_stop_delay'));
  const lifecycle = read(row, 'lifecycle_status') ?? read(row, 'current_status');
  return [
    titleLine(`🚆 ${escapeTelegramHtml(displayCode)} · ${escapeTelegramHtml(report.trainId)}`),
    `<i>${escapeTelegramHtml(humanKey(lifecycle))}</i>`,
    '',
    '<b>Journey</b>',
    `Scheduled: <b>${formatTime(read(row, 'scheduled_start_at'))} → ${formatTime(read(row, 'scheduled_end_at'))}</b>`,
    destination === null
      ? `Associated stop: <b>${escapeTelegramHtml(associatedStop ?? 'Unavailable')}</b>`
      : `Destination: <b>${escapeTelegramHtml(destination)}</b>`,
    `${delaySignal(delay)} Latest delay: <b>${duration(delay)}</b>`,
    '',
    '<b>Evidence</b>',
    `First: ${formatInstant(read(row, 'first_evidence_at'))}`,
    `Latest: ${formatInstant(read(row, 'last_evidence_at') ?? read(row, 'captured_at'))}`,
    ...(read(row, 'final_evidence_status') === null ? [] : [`Final stop status: <b>${escapeTelegramHtml(humanKey(read(row, 'final_evidence_status')))}</b>`]),
    `Renfe trip: <code>${escapeTelegramHtml(read(row, 'source_trip_id') ?? 'Unavailable')}</code>`,
  ].join('\n');
}

function formatPilot(report: Extract<ReportResult, { kind: 'pilot' }>): string {
  const successRate = report.polls > 0 ? report.successfulPolls / report.polls : null;
  return [
    titleLine('🧪 Pilot progress'),
    `<i>${escapeTelegramHtml(report.startedServiceDate ?? 'n/a')} → ${escapeTelegramHtml(report.latestServiceDate ?? 'n/a')} · ${report.serviceDays} service days</i>`,
    '',
    '<b>Collection</b>',
    `${metricSignal(successRate, 0.99, 0.95)} Successful polls: <b>${percent(successRate)}</b> · ${report.successfulPolls.toLocaleString('en-GB')} / ${report.polls.toLocaleString('en-GB')}`,
    `🚆 Madrid matches: <b>${report.matchedMadrid.toLocaleString('en-GB')}</b>`,
    `📡 Downloaded: <b>${formatBytesValue(report.responseBytes)}</b>`,
    '',
    '<b>Storage</b>',
    `🗄 Database: <b>${formatBytesValue(report.databaseBytes)}</b>`,
    `📈 Measured growth: <b>${report.measuredDatabaseGrowthBytes === null ? 'Unavailable' : formatSignedBytes(report.measuredDatabaseGrowthBytes)}</b>${report.measuredGrowthHours === null ? '' : ` over ${report.measuredGrowthHours.toFixed(1)} h`}`,
    `🔭 14-day projection: <b>${report.projectedVariableGrowth14DaysBytes === null ? 'Unavailable' : `+${formatBytesValue(report.projectedVariableGrowth14DaysBytes)}`}</b>`,
    '',
    '<i>Projection excludes future static-feed and index changes.</i>',
  ].join('\n');
}

function titleLine(value: string): string { return `<b>${value}</b>`; }
function percent(value: number | null): string { return value === null ? 'Unavailable' : `${(value * 100).toFixed(1)}%`; }
function metricSignal(value: number | null, good: number, warning: number): string { return value === null ? '⚪' : value >= good ? '🟢' : value >= warning ? '🟠' : '🔴'; }
function delaySignal(value: number | null): string { return value === null ? '⚪' : value <= 120 ? '🟢' : value <= 300 ? '🟠' : '🔴'; }
function ratioSignal(value: number | null, warning: number, critical: number, inverse: boolean): string {
  if (value === null) return '⚪';
  if (inverse) return value < critical ? '🔴' : value < warning ? '🟠' : '🟢';
  return value > critical ? '🔴' : value > warning ? '🟠' : '🟢';
}
function duration(value: number | null): string {
  if (value === null) return 'Unavailable';
  const sign = value < 0 ? '−' : '';
  const rounded = Math.round(Math.abs(value));
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return minutes === 0 ? `${sign}${seconds}s` : `${sign}${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}
function numeric(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
function read(record: Readonly<Record<string, unknown>> | null, key: string): unknown { return record?.[key] ?? null; }
function formatInteger(value: unknown): string { const number = numeric(value); return number === null ? 'Unavailable' : Math.round(number).toLocaleString('en-GB'); }
function instant(value: unknown): Date | null { const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null; return date !== null && !Number.isNaN(date.getTime()) ? date : null; }
function formatInstant(value: unknown): string { const date = instant(value); return date === null ? 'Unavailable' : escapeTelegramHtml(madridDateTime.format(date)); }
function formatTime(value: unknown): string { const date = instant(value); return date === null ? 'Unavailable' : escapeTelegramHtml(madridTime.format(date)); }
function formatServiceDate(value: unknown): string {
  if (typeof value !== 'string' && !(value instanceof Date)) return 'Unavailable';
  const date = value instanceof Date ? value : new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? escapeTelegramHtml(value) : escapeTelegramHtml(madridDate.format(date));
}
function formatBytesValue(value: unknown): string {
  const number = numeric(value);
  if (number === null) return 'Unavailable';
  if (number >= 1024 ** 3) return `${(number / 1024 ** 3).toFixed(2)} GiB`;
  if (number >= 1024 ** 2) return `${(number / 1024 ** 2).toFixed(1)} MiB`;
  if (number >= 1024) return `${(number / 1024).toFixed(1)} KiB`;
  return `${Math.round(number)} B`;
}
function formatSignedBytes(value: number): string { return `${value >= 0 ? '+' : '−'}${formatBytesValue(Math.abs(value))}`; }
function humanKey(value: unknown): string {
  if (value === null || value === undefined) return 'Unavailable';
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint' && typeof value !== 'boolean') return 'Unavailable';
  return String(value).replaceAll('.', ' · ').replaceAll('_', ' ');
}
function vehicleLocation(status: string, station: string | null): string {
  const name = escapeTelegramHtml(station ?? 'stop unavailable');
  if (status === 'STOPPED_AT') return `📍 At ${name}`;
  if (status === 'INCOMING_AT') return `↘️ Approaching ${name}`;
  if (status === 'IN_TRANSIT_TO') return `➡️ Next ${name}`;
  return `📍 Associated stop: ${name}`;
}
