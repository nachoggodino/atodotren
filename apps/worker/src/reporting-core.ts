export const REPORT_CONTRACT_VERSION = 'report-v1';
export const REPORT_TIMEZONE = 'Europe/Madrid';
export const PUNCTUALITY_THRESHOLD_SECONDS = 120;
export const MAX_REPORT_LOOKBACK_DAYS = 400;
export const MAX_TRAINS = 20;
export const MAX_INCIDENTS = 20;
export const MAX_LOOKUP_CANDIDATES = 5;
export const MIN_WORST_LINE_OBSERVATIONS = 100;
export const MIN_WORST_STATION_OBSERVATIONS = 30;

export interface ChartSpec {
  readonly kind: 'line';
  readonly title: string;
  readonly xLabel: string;
  readonly yLabel: string;
  readonly points: readonly { readonly x: string; readonly y: number | null; readonly sampleSize: number }[];
}

export interface LookupCandidate {
  readonly id: number;
  readonly label: string;
  readonly code?: string;
  readonly aliases: readonly string[];
  readonly score: number;
}

export interface MetricSummary {
  readonly scheduledStopOpportunities: number;
  readonly usableObservations: number;
  readonly coverage: number | null;
  readonly punctualCount: number;
  readonly punctuality: number | null;
  readonly averageArrivalDelaySeconds: number | null;
  readonly medianArrivalDelaySeconds: number | null;
  readonly canceled: number;
  readonly canceledRate: number | null;
  readonly missingEvidence: number;
  readonly missingEvidenceRate: number | null;
}

export interface SummaryRow {
  service_date: string | Date;
  scheduled_opportunities: string | number;
  valid_delay_observations: string | number;
  punctual_count: string | number;
  canceled_count: string | number;
  missing_evidence_count: string | number;
  signed_delay_sum: string | number;
  delay_histogram: number[] | null;
  aggregate_algorithm_version?: string;
  aggregate_algorithm_version_max?: string;
}

export interface NamedSummaryRow extends SummaryRow {
  line_id?: string | number;
  station_id?: string | number;
  public_code?: string;
  public_id?: string;
  name_es: string;
}

export interface HourRow {
  scheduled_hour: string | number;
  scheduled_opportunities: string | number;
  valid_delay_observations: string | number;
  punctual_count: string | number;
  signed_delay_sum: string | number;
  delay_histogram: number[] | null;
}

export interface ReportBase {
  readonly contractVersion: typeof REPORT_CONTRACT_VERSION;
  readonly generatedAt: string;
  readonly timezone: typeof REPORT_TIMEZONE;
  readonly source: string;
  readonly precision: string;
}

export interface DailyReport extends ReportBase {
  readonly kind: 'daily';
  readonly serviceDate: string;
  readonly finalization: { readonly status: string; readonly finalizedAt: string | null; readonly algorithmVersion: string | null };
  readonly metrics: MetricSummary;
  readonly worstLine: { readonly id: number; readonly name: string; readonly code: string; readonly punctuality: number | null; readonly sampleSize: number } | null;
  readonly worstStation: { readonly id: number; readonly name: string; readonly punctuality: number | null; readonly sampleSize: number } | null;
  readonly chart: ChartSpec;
}

export interface LineReport extends ReportBase {
  readonly kind: 'line';
  readonly serviceDate: string;
  readonly line: { readonly id: number; readonly name: string; readonly code: string };
  readonly metrics: MetricSummary;
  readonly chart: ChartSpec;
}

export interface StationReport extends ReportBase {
  readonly kind: 'station';
  readonly serviceDate: string;
  readonly station: { readonly id: number; readonly name: string; readonly publicId: string };
  readonly metrics: MetricSummary;
  readonly chart: ChartSpec;
}

export interface StatusReport extends ReportBase {
  readonly kind: 'status';
  readonly ingestion: Readonly<Record<string, unknown>> | null;
  readonly canonical: Readonly<Record<string, unknown>> | null;
  readonly latestFinalization: Readonly<Record<string, unknown>> | null;
  readonly staticFeed: Readonly<Record<string, unknown>> | null;
  readonly openIncidents: number;
  readonly openMonitorEpisodes: readonly Readonly<Record<string, unknown>>[];
}

export interface IncidentsReport extends ReportBase {
  readonly kind: 'incidents';
  readonly incidents: readonly Readonly<Record<string, unknown>>[];
}

export interface TrainsReport extends ReportBase {
  readonly kind: 'trains';
  readonly line: { readonly id: number; readonly name: string; readonly code: string };
  readonly trains: readonly {
    readonly trainId: string;
    readonly sourceTripId: string;
    readonly vehicleId: string | null;
    readonly capturedAt: string;
    readonly station: string | null;
    readonly status: string;
    readonly delaySeconds: number | null;
  }[];
}

export interface TrainReport extends ReportBase {
  readonly kind: 'train';
  readonly trainId: string;
  readonly journey: Readonly<Record<string, unknown>> | null;
}

export interface PilotReport extends ReportBase {
  readonly kind: 'pilot';
  readonly startedServiceDate: string | null;
  readonly latestServiceDate: string | null;
  readonly serviceDays: number;
  readonly polls: number;
  readonly successfulPolls: number;
  readonly matchedMadrid: number;
  readonly responseBytes: number;
  readonly databaseBytes: number | null;
  readonly measuredDatabaseGrowthBytes: number | null;
  readonly measuredGrowthHours: number | null;
  readonly projectedVariableGrowth14DaysBytes: number | null;
}

export type ReportResult = DailyReport | LineReport | StationReport | StatusReport | IncidentsReport | TrainsReport | TrainReport | PilotReport;

export function numberValue(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = numberValue(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function dateText(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

export function instantText(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : null;
}

export function normalizeLookup(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}

export function compactLookup(value: string): string {
  return normalizeLookup(value).replaceAll(' ', '');
}

export function currentMadridServiceDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

export function shiftIsoDate(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

export function parseReportDate(value: string | undefined, now: Date = new Date()): string {
  const current = currentMadridServiceDate(now);
  if (value === undefined || value === '') return current;
  const resolved = value === 'yesterday' ? shiftIsoDate(current, -1) : value;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(resolved)) throw new RangeError('Date must be yesterday or YYYY-MM-DD');
  const parsed = new Date(`${resolved}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== resolved) throw new RangeError('Date must be a real ISO calendar date');
  const currentMs = new Date(`${current}T00:00:00.000Z`).getTime();
  const days = Math.round((parsed.getTime() - currentMs) / 86_400_000);
  if (days < -MAX_REPORT_LOOKBACK_DAYS || days > 1) throw new RangeError(`Date must be within ${MAX_REPORT_LOOKBACK_DAYS} days before or one day after the current Madrid service date`);
  return resolved;
}

export function approximateMedianFromHistogram(histogram: readonly number[] | null, sampleSize: number): number | null {
  if (histogram === null || sampleSize <= 0 || histogram.length !== 72) return null;
  const target = Math.floor((sampleSize - 1) / 2) + 1;
  let cumulative = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    cumulative += histogram[index] ?? 0;
    if (cumulative >= target) {
      if (index === 0) return -315;
      if (index === 71) return 1815;
      return -300 + (index - 1) * 30 + 15;
    }
  }
  return null;
}

export function metricSummary(row: SummaryRow | undefined): MetricSummary {
  const scheduled = numberValue(row?.scheduled_opportunities);
  const usable = numberValue(row?.valid_delay_observations);
  const punctual = numberValue(row?.punctual_count);
  const canceled = numberValue(row?.canceled_count);
  const missing = numberValue(row?.missing_evidence_count);
  const signed = numberValue(row?.signed_delay_sum);
  const rate = (numerator: number, denominator: number): number | null => denominator > 0 ? numerator / denominator : null;
  return {
    scheduledStopOpportunities: scheduled, usableObservations: usable, coverage: rate(usable, scheduled),
    punctualCount: punctual, punctuality: rate(punctual, usable),
    averageArrivalDelaySeconds: usable > 0 ? signed / usable : null,
    medianArrivalDelaySeconds: approximateMedianFromHistogram(row?.delay_histogram ?? null, usable),
    canceled, canceledRate: rate(canceled, scheduled), missingEvidence: missing, missingEvidenceRate: rate(missing, scheduled),
  };
}

export function reportBase(now: Date): ReportBase {
  return {
    contractVersion: REPORT_CONTRACT_VERSION, generatedAt: now.toISOString(), timezone: REPORT_TIMEZONE,
    source: 'daily_aggregate',
    precision: 'counts/sums exact within aggregate; median uses h30-v1 30-second histogram midpoint',
  };
}

export function candidateScore(query: string, values: readonly string[]): number {
  let best = 0;
  for (const value of values) {
    const normalized = normalizeLookup(value);
    if (normalized === query) best = Math.max(best, 100);
    else if (normalized.startsWith(query)) best = Math.max(best, 80 - Math.min(20, normalized.length - query.length));
    else {
      const position = normalized.indexOf(query);
      if (position >= 0) best = Math.max(best, 60 - Math.min(30, position));
    }
  }
  return best;
}
