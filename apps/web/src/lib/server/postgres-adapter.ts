import "server-only";

import { Pool, type QueryResultRow } from "pg";
import type { HistoryFilters, HistoryPoint, HistoryResponse, LinePerformance, LineRef, MatrixCell, MatrixJourney, ResponseMeta, SearchResult, StationRef, SummaryStats, TrainDetail } from "@/lib/domain/contracts";
import { FALLBACK_LINE_COLORS } from "@/lib/design/tokens";
import { SEARCH_RESULT_LIMIT } from "@/lib/domain/search";
import type { PublicDataAdapter } from "./data-adapter";
import type { WebServerConfig } from "./config";
import { madridDate } from "./history-request";

const LIVE_STALE_AFTER_MS = 120_000;
const MIN_LINE_RANKING_SAMPLE = 100;
const MATRIX_MAX_ROWS = 6_000;
const NETWORK_VEHICLE_LIMIT = 240;
const STATION_VEHICLE_LIMIT = 60;

function numberValue(value: unknown): number { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function nullableNumber(value: unknown): number | null { if (value === null || value === undefined) return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function stringValue(value: unknown): string { return String(value ?? ""); }
function iso(value: unknown): string | null { if (value === null || value === undefined) return null; const date = value instanceof Date ? value : new Date(String(value)); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function histogram(value: unknown): readonly number[] { return Array.isArray(value) ? value.map(numberValue) : []; }

function medianFromHistogram(values: readonly number[]): number | null {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total === 0) return null;
  const target = total / 2;
  let seen = 0;
  for (let index = 0; index < values.length; index += 1) {
    seen += values[index] ?? 0;
    if (seen >= target) {
      if (index === 0) return -315;
      if (index === 71) return 1815;
      return -300 + (index - 1) * 30 + 15;
    }
  }
  return null;
}

function summaryFromRow(row: QueryResultRow | undefined): SummaryStats {
  if (row === undefined) return { scheduled: 0, observed: 0, punctuality: null, meanDelaySeconds: null, medianDelaySeconds: null, canceled: 0, missing: 0, distribution: [] };
  const scheduled = numberValue(row.scheduled_opportunities);
  const observed = numberValue(row.valid_delay_observations);
  const punctual = numberValue(row.punctual_count);
  const signed = numberValue(row.signed_delay_sum);
  const delayHistogram = histogram(row.delay_histogram);
  return { scheduled, observed, punctuality: observed === 0 ? null : punctual / observed, meanDelaySeconds: observed === 0 ? null : Math.round(signed / observed), medianDelaySeconds: medianFromHistogram(delayHistogram), canceled: numberValue(row.canceled_count), missing: numberValue(row.missing_evidence_count), distribution: delayHistogram };
}

function mergeRows(rows: readonly QueryResultRow[]): SummaryStats {
  if (rows.length === 0) return summaryFromRow(undefined);
  const scheduled = rows.reduce((sum, row) => sum + numberValue(row.scheduled_opportunities), 0);
  const observed = rows.reduce((sum, row) => sum + numberValue(row.valid_delay_observations), 0);
  const punctual = rows.reduce((sum, row) => sum + numberValue(row.punctual_count), 0);
  const signed = rows.reduce((sum, row) => sum + numberValue(row.signed_delay_sum), 0);
  const canceled = rows.reduce((sum, row) => sum + numberValue(row.canceled_count), 0);
  const missing = rows.reduce((sum, row) => sum + numberValue(row.missing_evidence_count), 0);
  const length = Math.max(0, ...rows.map((row) => histogram(row.delay_histogram).length));
  const distribution = Array.from({ length }, (_, index) => rows.reduce((sum, row) => sum + (histogram(row.delay_histogram)[index] ?? 0), 0));
  return { scheduled, observed, punctuality: observed === 0 ? null : punctual / observed, meanDelaySeconds: observed === 0 ? null : Math.round(signed / observed), medianDelaySeconds: medianFromHistogram(distribution), canceled, missing, distribution };
}

function lineFromRow(row: QueryResultRow): LineRef {
  const slug = stringValue(row.line_slug ?? row.slug);
  const rawColor = stringValue(row.color).replace(/^#/, "");
  return { id: `line-${slug}`, slug, code: stringValue(row.public_code), name: { es: stringValue(row.line_name_es ?? row.name_es ?? row.public_code), en: stringValue(row.line_name_en ?? row.name_en ?? row.public_code) }, color: /^[0-9a-f]{6}$/i.test(rawColor) ? `#${rawColor}` : FALLBACK_LINE_COLORS[slug] ?? "#59646a" };
}

function stationFromRow(row: QueryResultRow): StationRef {
  const id = stringValue(row.station_id ?? row.current_station_id);
  return { id, slug: { es: stringValue(row.station_slug_es ?? row.current_station_slug_es ?? id), en: stringValue(row.station_slug_en ?? row.current_station_slug_en ?? id) }, name: { es: stringValue(row.station_name_es ?? row.current_station_name_es ?? row.name_es ?? id), en: stringValue(row.station_name_en ?? row.current_station_name_en ?? row.name_en ?? id) } };
}

function coverage(stats: SummaryStats): ResponseMeta["coverage"] {
  return { scheduled: stats.scheduled, observed: stats.observed, ratio: stats.scheduled === 0 ? null : stats.observed / stats.scheduled };
}

function liveMetaFrom(stats: SummaryStats, sourceAt: string | null, finalized: boolean, algorithmVersion: string | null, precision: ResponseMeta["precision"] = "aggregate"): ResponseMeta {
  const stale = sourceAt !== null && Date.now() - Date.parse(sourceAt) > LIVE_STALE_AFTER_MS;
  const status = sourceAt === null ? "outage" : stale ? "stale" : "live";
  return { generatedAt: new Date().toISOString(), sourceAt, status, stale, coverage: coverage(stats), finalized, algorithmVersion, precision, exact: precision === "reported", cache: "origin", serviceDate: madridDate() };
}

function historicalMetaFrom(stats: SummaryStats, finalized: boolean, algorithmVersion: string | null, precision: ResponseMeta["precision"] = "aggregate", serviceDate: string = madridDate()): ResponseMeta {
  return { generatedAt: new Date().toISOString(), sourceAt: null, status: "live", stale: false, coverage: coverage(stats), finalized, algorithmVersion, precision, exact: precision === "reported", cache: "origin", serviceDate };
}

function historyPoint(date: string, rows: readonly QueryResultRow[]): HistoryPoint {
  const stats = mergeRows(rows);
  return { date, scheduled: stats.scheduled, observed: stats.observed, punctuality: stats.punctuality, meanDelaySeconds: stats.meanDelaySeconds, coverage: stats.scheduled === 0 ? null : stats.observed / stats.scheduled };
}

function filterWeekdays(rows: readonly QueryResultRow[], filters: HistoryFilters): QueryResultRow[] {
  if (filters.weekdays.length === 0) return [...rows];
  return rows.filter((row) => filters.weekdays.includes(new Date(`${stringValue(row.service_date).slice(0, 10)}T12:00:00Z`).getUTCDay()));
}

function historyFromRows(kind: "network" | "line" | "station", label: string, id: string, filters: HistoryFilters, rows: readonly QueryResultRow[], rankings: HistoryResponse["rankings"]): HistoryResponse {
  const filtered = filterWeekdays(rows, filters);
  const byDate = new Map<string, QueryResultRow[]>();
  for (const row of filtered) { const date = stringValue(row.service_date).slice(0, 10); const values = byDate.get(date) ?? []; values.push(row); byDate.set(date, values); }
  const trend = [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, values]) => historyPoint(date, values));
  const stats = mergeRows(filtered);
  const finalized = filters.to < madridDate();
  return { meta: historicalMetaFrom(stats, finalized, stringValue(filtered[0]?.aggregate_algorithm_version) || null, "aggregate", filters.to), context: { kind, label, id }, filters, stats, trend, rankings };
}

export function createPostgresAdapter(config: WebServerConfig): PublicDataAdapter {
  const pool = new Pool({ connectionString: config.databaseUrl ?? undefined, ssl: config.databaseSslMode === "disable" ? false : { rejectUnauthorized: false }, max: config.poolMax, statement_timeout: config.statementTimeoutMs, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, application_name: "atodotren-web" });

  async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<readonly T[]> { const result = await pool.query<T>(text, [...values]); return result.rows; }
  async function health(): Promise<string | null> { const rows = await query("SELECT latest_successful_poll_at FROM api.live_health LIMIT 1"); return iso(rows[0]?.latest_successful_poll_at); }
  async function lineCatalog(slug?: string): Promise<readonly QueryResultRow[]> { return query(`SELECT * FROM api.line_catalog WHERE network_slug = 'madrid' ${slug === undefined ? "" : "AND slug = $1"} ORDER BY display_order, public_code LIMIT 32`, slug === undefined ? [] : [slug]); }
  async function stationCatalog(slug: string): Promise<QueryResultRow | undefined> { return (await query("SELECT * FROM api.station_catalog WHERE network_slug = 'madrid' AND (slug_es = $1 OR slug_en = $1 OR public_id = $1) LIMIT 1", [slug]))[0]; }
  async function topology(lineSlug: string): Promise<readonly QueryResultRow[]> { return query("SELECT DISTINCT ON (stop_order) * FROM api.schematic_pattern_stop WHERE network_slug = 'madrid' AND line_slug = $1 ORDER BY stop_order, pattern_id LIMIT 120", [lineSlug]); }
  async function vehicleRows(lineSlug?: string): Promise<readonly QueryResultRow[]> { return query(`SELECT * FROM api.live_vehicle WHERE network_slug = 'madrid' ${lineSlug === undefined ? "" : "AND line_slug = $1"} ORDER BY captured_at DESC LIMIT ${NETWORK_VEHICLE_LIMIT}`, lineSlug === undefined ? [] : [lineSlug]); }
  async function stationVehicleRows(stationId: string): Promise<readonly QueryResultRow[]> { return query(`SELECT * FROM api.live_vehicle WHERE network_slug = 'madrid' AND current_station_id = $1 ORDER BY captured_at DESC LIMIT ${STATION_VEHICLE_LIMIT}`, [stationId]); }

  async function trainsForLine(line: LineRef, rows: readonly QueryResultRow[], stops: readonly StationRef[]): Promise<readonly TrainDetail[]> {
    const stopIndex = new Map(stops.map((stop, index) => [stop.id, index]));
    return rows.map((row) => {
      const currentId = row.current_station_id === null ? null : stringValue(row.current_station_id);
      const index = currentId === null ? -1 : stopIndex.get(currentId) ?? -1;
      const status = stringValue(row.current_status).toUpperCase();
      const current = index >= 0 ? stops[index] ?? null : null;
      const previous = index > 0 ? stops[index - 1] ?? null : null;
      const stopped = status.includes("STOPPED") || status.includes("AT_STOP");
      const position = stopped && current !== null
        ? { kind: "at_station" as const, stationId: current.id, fromStationId: null, toStationId: null, progress: null, basis: "reported-stop" as const, confidence: "medium" as const }
        : current !== null && previous !== null
          ? { kind: "between_stations" as const, stationId: null, fromStationId: previous.id, toStationId: current.id, progress: .5, basis: "feed-inferred" as const, confidence: "low" as const }
          : { kind: "unknown" as const, stationId: currentId, fromStationId: null, toStationId: null, progress: null, basis: "unavailable" as const, confidence: "unavailable" as const };
      const delay = nullableNumber(row.latest_stop_delay);
      return { id: stringValue(row.vehicle_id || row.state_key), journeyId: stringValue(row.journey_id ?? row.source_trip_id), serviceDate: stringValue(row.service_date).slice(0, 10), line, destination: stops.at(-1) ?? null, position, scheduledArrivalAt: null, probableArrivalAt: null, renfeReportedArrivalAt: null, observedPresenceAt: stopped ? iso(row.vehicle_timestamp ?? row.captured_at) : null, delaySeconds: delay, state: stopped ? "observed_presence" : delay === null ? "pending" : "reported_only", sourceAt: iso(row.vehicle_timestamp ?? row.captured_at) };
    });
  }

  return {
    async search(searchTerm) { const rows = await query("SELECT * FROM api.catalog_search($1, $2)", [searchTerm, SEARCH_RESULT_LIMIT]); return rows.map<SearchResult>((row) => ({ kind: stringValue(row.entity_kind) === "line" ? "line" : "station", id: stringValue(row.stable_id), slug: { es: stringValue(row.slug_es), en: stringValue(row.slug_en) }, code: row.public_code === null ? null : stringValue(row.public_code), name: { es: stringValue(row.name_es), en: stringValue(row.name_en) } })); },
    async liveNetwork() {
      const [catalog, vehicles, sourceAt, summaryRows] = await Promise.all([lineCatalog(), vehicleRows(), health(), query("SELECT * FROM api.history_network_day WHERE network_slug = 'madrid' AND service_date = $1 LIMIT 1", [madridDate()])]);
      const stats = summaryFromRow(summaryRows[0]);
      const counts = new Map<string, number>(); for (const row of vehicles) counts.set(stringValue(row.line_slug), (counts.get(stringValue(row.line_slug)) ?? 0) + 1);
      const lines: LinePerformance[] = catalog.map((row) => ({ ...lineFromRow(row), stats: summaryFromRow(undefined), activeTrains: counts.get(stringValue(row.slug)) ?? 0 }));
      const meta = liveMetaFrom(stats, sourceAt, false, stringValue(summaryRows[0]?.aggregate_algorithm_version) || null, "mixed");
      return { meta: vehicles.length === 0 && meta.status === "live" ? { ...meta, status: "overnight" } : meta, stats, lines };
    },
    async liveLine(slug) {
      const catalog = await lineCatalog(slug); const lineRow = catalog[0]; if (lineRow === undefined) return null; const line = lineFromRow(lineRow);
      const [vehicles, sourceAt, summaryRows, topologyRows] = await Promise.all([vehicleRows(slug), health(), query("SELECT * FROM api.history_line_day WHERE network_slug = 'madrid' AND line_slug = $1 AND service_date = $2 LIMIT 1", [slug, madridDate()]), topology(slug)]);
      const rawStops = topologyRows.map(stationFromRow); const stops = rawStops.filter((stop, index) => rawStops.findIndex((candidate) => candidate.id === stop.id) === index);
      const schematicStops = stops.map((station, index) => ({ station, order: index }));
      const stats = summaryFromRow(summaryRows[0]); const trainModels = await trainsForLine(line, vehicles, stops);
      const meta = liveMetaFrom(stats, sourceAt, false, stringValue(summaryRows[0]?.aggregate_algorithm_version) || null, "mixed");
      return { meta: trainModels.length === 0 && meta.status === "live" ? { ...meta, status: "overnight" } : meta, context: line, stats, comparison: { label: "same-weekday-hour", punctuality: null, meanDelaySeconds: null }, stops: schematicStops, trains: trainModels };
    },
    async liveStation(slug) {
      const stationRow = await stationCatalog(slug); if (stationRow === undefined) return null; const station = stationFromRow(stationRow);
      const [rows, sourceAt, vehicles] = await Promise.all([query("SELECT * FROM api.history_station_hour WHERE network_slug = 'madrid' AND station_id = $1 AND service_date = $2", [station.id, madridDate()]), health(), stationVehicleRows(station.id)]);
      const stats = mergeRows(rows);
      const trainModels: TrainDetail[] = vehicles.map((row) => { const line = lineFromRow(row); const delay = nullableNumber(row.latest_stop_delay); return { id: stringValue(row.vehicle_id || row.state_key), journeyId: stringValue(row.journey_id ?? row.source_trip_id), serviceDate: stringValue(row.service_date).slice(0, 10), line, destination: null, position: { kind: "unknown", stationId: station.id, fromStationId: null, toStationId: null, progress: null, basis: "feed-inferred", confidence: "low" }, scheduledArrivalAt: null, probableArrivalAt: null, renfeReportedArrivalAt: null, observedPresenceAt: iso(row.vehicle_timestamp), delaySeconds: delay, state: delay === null ? "pending" : "reported_only", sourceAt: iso(row.vehicle_timestamp ?? row.captured_at) }; });
      return { meta: liveMetaFrom(stats, sourceAt, false, stringValue(rows[0]?.aggregate_algorithm_version) || null, "mixed"), context: station, stats, comparison: { label: "same-weekday-hour", punctuality: null, meanDelaySeconds: null }, stops: [], trains: trainModels };
    },
    async journey(serviceDate, journeyId) {
      if (!/^\d+$/.test(journeyId)) return null; const rows = await query("SELECT * FROM api.recent_journey($1::date, $2::bigint)", [serviceDate, journeyId]); const first = rows[0]; if (first === undefined) return null;
      const line = lineFromRow(first); const last = rows.at(-1); const delay = nullableNumber(last?.selected_delay_seconds); const scheduled = iso(last?.scheduled_arrival_at);
      return { id: stringValue(first.source_trip_id), journeyId, serviceDate, line, destination: last === undefined ? null : stationFromRow(last), position: { kind: "unknown", stationId: null, fromStationId: null, toStationId: null, progress: null, basis: "unavailable", confidence: "unavailable" }, scheduledArrivalAt: scheduled, probableArrivalAt: scheduled === null || delay === null ? null : new Date(Date.parse(scheduled) + delay * 1000).toISOString(), renfeReportedArrivalAt: iso(last?.renfe_arrival_at), observedPresenceAt: iso(last?.first_stopped_presence_at), delaySeconds: delay, state: (stringValue(last?.evidence_status) || "pending") as TrainDetail["state"], sourceAt: iso(last?.evidence_selected_captured_at) };
    },
    async historyNetwork(filters) {
      const useHour = filters.hour !== null || filters.direction !== null; const clauses = ["network_slug = 'madrid'", "service_date BETWEEN $1 AND $2"]; const values: unknown[] = [filters.from, filters.to]; if (useHour && filters.hour !== null) { values.push(filters.hour); clauses.push(`scheduled_hour = $${values.length}`); } if (useHour && filters.direction !== null) { values.push(filters.direction); clauses.push(`direction = $${values.length}`); }
      const rows = await query(`SELECT * FROM api.${useHour ? "history_network_hour" : "history_network_day"} WHERE ${clauses.join(" AND ")} ORDER BY service_date LIMIT 9000`, values);
      const rankingRows = await query("SELECT line_slug, public_code, sum(valid_delay_observations) AS valid_delay_observations, sum(punctual_count) AS punctual_count, sum(signed_delay_sum) AS signed_delay_sum FROM api.history_line_day WHERE network_slug='madrid' AND service_date BETWEEN $1 AND $2 GROUP BY line_slug, public_code HAVING sum(valid_delay_observations) >= $3 ORDER BY (sum(signed_delay_sum)::numeric / NULLIF(sum(valid_delay_observations),0)) DESC LIMIT 8", [filters.from, filters.to, MIN_LINE_RANKING_SAMPLE]);
      const rankings = rankingRows.map((row) => { const sample = numberValue(row.valid_delay_observations); return { id: stringValue(row.line_slug), label: stringValue(row.public_code), sample, meanDelaySeconds: sample === 0 ? null : Math.round(numberValue(row.signed_delay_sum) / sample), punctuality: sample === 0 ? null : numberValue(row.punctual_count) / sample }; });
      return historyFromRows("network", "Cercanías Madrid", "madrid", filters, rows, rankings);
    },
    async historyLine(slug, filters) {
      const catalog = await lineCatalog(slug); if (catalog[0] === undefined) return null; const useHour = filters.hour !== null || filters.direction !== null; const clauses = ["network_slug='madrid'", "line_slug=$1", "service_date BETWEEN $2 AND $3"]; const values: unknown[] = [slug, filters.from, filters.to]; if (useHour && filters.hour !== null) { values.push(filters.hour); clauses.push(`scheduled_hour = $${values.length}`); } if (useHour && filters.direction !== null) { values.push(filters.direction); clauses.push(`direction = $${values.length}`); }
      const rows = await query(`SELECT * FROM api.${useHour ? "history_line_hour" : "history_line_day"} WHERE ${clauses.join(" AND ")} ORDER BY service_date LIMIT 5000`, values); return historyFromRows("line", stringValue(catalog[0].public_code), `line-${slug}`, filters, rows, []);
    },
    async historyStation(slug, filters) {
      const station = await stationCatalog(slug); if (station === undefined) return null; const id = stringValue(station.station_id); const clauses = ["network_slug='madrid'", "station_id=$1", "service_date BETWEEN $2 AND $3"]; const values: unknown[] = [id, filters.from, filters.to]; if (filters.hour !== null) { values.push(filters.hour); clauses.push(`scheduled_hour = $${values.length}`); } if (filters.direction !== null) { values.push(filters.direction); clauses.push(`direction = $${values.length}`); }
      const rows = await query(`SELECT * FROM api.history_station_hour WHERE ${clauses.join(" AND ")} ORDER BY service_date LIMIT 7000`, values); return historyFromRows("station", stringValue(station.name_es), id, filters, rows, []);
    },
    async matrix(lineSlug, serviceDate) {
      const catalog = await lineCatalog(lineSlug); if (catalog[0] === undefined) return null; const rows = await query("SELECT * FROM api.recent_line_matrix($1, $2::date, $3::integer)", [lineSlug, serviceDate, MATRIX_MAX_ROWS]);
      const stationMap = new Map<string, StationRef>(); const journeyMap = new Map<string, MatrixJourney>(); const cells: MatrixCell[] = [];
      for (const row of rows) { const station = stationFromRow(row); stationMap.set(station.id, station); const journeyId = stringValue(row.journey_id); journeyMap.set(journeyId, { id: journeyId, label: stringValue(row.source_trip_id), direction: row.direction === null ? null : Number(row.direction) === 1 ? 1 : 0 }); cells.push({ journeyId, stationId: station.id, scheduledAt: iso(row.scheduled_arrival_at) ?? "", reportedAt: iso(row.renfe_arrival_at), delaySeconds: nullableNumber(row.selected_delay_seconds), state: (stringValue(row.evidence_status) || "pending") as MatrixCell["state"] }); }
      const stats: SummaryStats = { scheduled: cells.length, observed: cells.filter((cell) => cell.delaySeconds !== null).length, punctuality: null, meanDelaySeconds: null, medianDelaySeconds: null, canceled: cells.filter((cell) => cell.state === "canceled").length, missing: cells.filter((cell) => cell.state === "missing_evidence").length, distribution: [] };
      return { meta: historicalMetaFrom(stats, serviceDate < madridDate(), stringValue(rows[0]?.canonical_algorithm_version) || null, "aggregate", serviceDate), line: lineFromRow(catalog[0]), date: serviceDate, stations: [...stationMap.values()], journeys: [...journeyMap.values()], cells };
    },
    async close() { await pool.end(); },
  };
}
