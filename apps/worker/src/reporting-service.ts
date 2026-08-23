import type { DatabaseConnection } from '@atodotren/db';

import {
  MAX_LOOKUP_CANDIDATES,
  candidateScore,
  dateText,
  instantText,
  metricSummary,
  normalizeLookup,
  numberValue,
  parseReportDate,
  reportBase,
  type DailyReport,
  type HourRow,
  type LineReport,
  type LookupCandidate,
  type NamedSummaryRow,
  type StationReport,
  type SummaryRow,
} from './reporting-core.js';

type Pool = DatabaseConnection['pool'];

export class ReportingService {
  readonly #pool: Pool;
  readonly #now: () => Date;

  public constructor(pool: Pool, now: () => Date = () => new Date()) {
    this.#pool = pool;
    this.#now = now;
  }

  public get pool(): Pool {
    return this.#pool;
  }

  public now(): Date {
    return this.#now();
  }

  public async lineCandidates(input: string): Promise<readonly LookupCandidate[]> {
    const query = normalizeLookup(input);
    if (query.length < 1 || query.length > 80) throw new RangeError('Line lookup must contain 1 through 80 normalized characters');
    const result = await this.#pool.query<Record<string, unknown>>(
      `SELECT line_id, public_code, name_es, aliases, normalized_slug
       FROM operations.report_line_lookup
       WHERE normalized_search LIKE '%' || $1 || '%'
       ORDER BY display_order, name_es
       LIMIT 20`, [query],
    );
    return result.rows.map((row) => ({
      id: numberValue(row.line_id), label: String(row.name_es), code: String(row.public_code),
      aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
      score: candidateScore(query, [String(row.public_code), String(row.name_es), String(row.normalized_slug), ...(Array.isArray(row.aliases) ? row.aliases.map(String) : [])]),
    })).sort((left, right) => right.score - left.score || left.label.localeCompare(right.label)).slice(0, MAX_LOOKUP_CANDIDATES);
  }

  public async stationCandidates(input: string): Promise<readonly LookupCandidate[]> {
    const query = normalizeLookup(input);
    if (query.length < 1 || query.length > 80) throw new RangeError('Station lookup must contain 1 through 80 normalized characters');
    const result = await this.#pool.query<Record<string, unknown>>(
      `SELECT station_id, public_id, name_es, aliases, normalized_slug
       FROM operations.report_station_lookup
       WHERE normalized_search LIKE '%' || $1 || '%'
       ORDER BY name_es
       LIMIT 20`, [query],
    );
    return result.rows.map((row) => ({
      id: numberValue(row.station_id), label: String(row.name_es), code: String(row.public_id),
      aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
      score: candidateScore(query, [String(row.public_id), String(row.name_es), String(row.normalized_slug), ...(Array.isArray(row.aliases) ? row.aliases.map(String) : [])]),
    })).sort((left, right) => right.score - left.score || left.label.localeCompare(right.label)).slice(0, MAX_LOOKUP_CANDIDATES);
  }

  public async daily(dateInput?: string): Promise<DailyReport> {
    const now = this.#now();
    const serviceDate = parseReportDate(dateInput, now);
    const [summary, trend, worstLine, worstStation, finalization] = await Promise.all([
      this.#pool.query<SummaryRow>('SELECT * FROM operations.report_daily_summary WHERE service_date = $1::date', [serviceDate]),
      this.#pool.query<SummaryRow>(`SELECT * FROM operations.report_daily_summary
        WHERE service_date BETWEEN $1::date - 6 AND $1::date ORDER BY service_date`, [serviceDate]),
      this.#pool.query<NamedSummaryRow>(`SELECT * FROM operations.report_line_summary
        WHERE service_date = $1::date AND valid_delay_observations > 0
        ORDER BY punctual_count::numeric / NULLIF(valid_delay_observations, 0), valid_delay_observations DESC LIMIT 1`, [serviceDate]),
      this.#pool.query<NamedSummaryRow>(`SELECT * FROM operations.report_station_summary
        WHERE service_date = $1::date AND valid_delay_observations > 0
        ORDER BY punctual_count::numeric / NULLIF(valid_delay_observations, 0), valid_delay_observations DESC LIMIT 1`, [serviceDate]),
      this.#pool.query<Record<string, unknown>>(`SELECT service_date, aggregate_algorithm_version, status, finalized_at
        FROM operations.report_finalization WHERE service_date = $1::date
        ORDER BY finalized_at DESC LIMIT 1`, [serviceDate]),
    ]);
    const lineRow = worstLine.rows[0];
    const stationRow = worstStation.rows[0];
    const finalizationRow = finalization.rows[0];
    return {
      ...reportBase(now), kind: 'daily', serviceDate,
      finalization: {
        status: finalizationRow === undefined ? 'unfinalized' : String(finalizationRow.status),
        finalizedAt: instantText(finalizationRow?.finalized_at),
        algorithmVersion: finalizationRow === undefined ? null : String(finalizationRow.aggregate_algorithm_version),
      },
      metrics: metricSummary(summary.rows[0]),
      worstLine: lineRow === undefined ? null : {
        id: numberValue(lineRow.line_id), name: lineRow.name_es, code: lineRow.public_code ?? '',
        punctuality: metricSummary(lineRow).punctuality, sampleSize: numberValue(lineRow.valid_delay_observations),
      },
      worstStation: stationRow === undefined ? null : {
        id: numberValue(stationRow.station_id), name: stationRow.name_es,
        punctuality: metricSummary(stationRow).punctuality, sampleSize: numberValue(stationRow.valid_delay_observations),
      },
      chart: {
        kind: 'line', title: 'Seven-day average arrival delay', xLabel: 'Service date', yLabel: 'Seconds',
        points: trend.rows.map((row) => ({
          x: dateText(row.service_date),
          y: numberValue(row.valid_delay_observations) > 0 ? numberValue(row.signed_delay_sum) / numberValue(row.valid_delay_observations) : null,
          sampleSize: numberValue(row.valid_delay_observations),
        })),
      },
    };
  }

  public async line(lineId: number, dateInput?: string): Promise<LineReport | null> {
    if (!Number.isSafeInteger(lineId) || lineId <= 0) throw new RangeError('lineId must be a positive integer');
    const now = this.#now();
    const serviceDate = parseReportDate(dateInput, now);
    const [summary, hourly] = await Promise.all([
      this.#pool.query<NamedSummaryRow>('SELECT * FROM operations.report_line_summary WHERE service_date = $1::date AND line_id = $2', [serviceDate, lineId]),
      this.#pool.query<HourRow>(`SELECT * FROM operations.report_line_hour
        WHERE service_date = $1::date AND line_id = $2 ORDER BY scheduled_hour LIMIT 24`, [serviceDate, lineId]),
    ]);
    const row = summary.rows[0];
    if (row === undefined) return null;
    return {
      ...reportBase(now), kind: 'line', serviceDate,
      line: { id: lineId, name: row.name_es, code: row.public_code ?? '' },
      metrics: metricSummary(row),
      chart: hourlyChart(`Hourly delay — ${row.public_code ?? row.name_es}`, hourly.rows),
    };
  }

  public async station(stationId: number, dateInput?: string): Promise<StationReport | null> {
    if (!Number.isSafeInteger(stationId) || stationId <= 0) throw new RangeError('stationId must be a positive integer');
    const now = this.#now();
    const serviceDate = parseReportDate(dateInput, now);
    const [summary, hourly] = await Promise.all([
      this.#pool.query<NamedSummaryRow>('SELECT * FROM operations.report_station_summary WHERE service_date = $1::date AND station_id = $2', [serviceDate, stationId]),
      this.#pool.query<HourRow>(`SELECT * FROM operations.report_station_hour
        WHERE service_date = $1::date AND station_id = $2 ORDER BY scheduled_hour LIMIT 24`, [serviceDate, stationId]),
    ]);
    const row = summary.rows[0];
    if (row === undefined) return null;
    return {
      ...reportBase(now), kind: 'station', serviceDate,
      station: { id: stationId, name: row.name_es, publicId: row.public_id ?? '' },
      metrics: metricSummary(row),
      chart: hourlyChart(`Hourly delay — ${row.name_es}`, hourly.rows),
    };
  }
}

function hourlyChart(title: string, rows: readonly HourRow[]): LineReport['chart'] {
  return {
    kind: 'line', title, xLabel: 'Madrid scheduled hour', yLabel: 'Average delay seconds',
    points: rows.slice(0, 24).map((row) => ({
      x: `${String(numberValue(row.scheduled_hour)).padStart(2, '0')}:00`,
      y: numberValue(row.valid_delay_observations) > 0 ? numberValue(row.signed_delay_sum) / numberValue(row.valid_delay_observations) : null,
      sampleSize: numberValue(row.valid_delay_observations),
    })),
  };
}
