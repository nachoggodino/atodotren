import type { Capability, Comparison, LinePerformance, LineRef, LiveContextResponse, LiveNetworkResponse } from "@/lib/domain/contracts";
import { algorithmProvenance, liveResponseMeta } from "@/lib/domain/data-policy";
import { currentMadridDate, madridHour } from "@/lib/domain/dates";
import { fallbackLineColor, MADRID_NETWORK } from "@/lib/domain/network";
import type { CatalogRepository } from "./catalog-repository";
import type { PostgresClient, RawPostgresRow } from "./client";
import { liveTrainFromRow } from "./mappers/train";
import type { MetadataRepository } from "./metadata-repository";
import { parseAggregateRow, parseHealthTimestamp, parseLiveVehicleRow } from "./row-parser";
import { emptySummaryStats, summaryFromAggregateRows } from "./stats";
import type { TopologyRepository } from "./topology-repository";

const COMPARISON_LOOKBACK_DAYS = 56;
const COMPARISON_MIN_SAMPLE = 30;

function strictAggregate(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid ${field} aggregate`);
  return parsed;
}

function comparisonFromRow(row: RawPostgresRow | undefined): Capability<Comparison> {
  if (row === undefined || row.valid_delay_observations === null) return { status: "insufficient-sample" };
  const sample = strictAggregate(row.valid_delay_observations, "comparison sample");
  const punctual = strictAggregate(row.punctual_count, "comparison punctual count");
  const signed = Number(row.signed_delay_sum);
  if (!Number.isSafeInteger(signed)) throw new Error("Invalid comparison delay aggregate");
  if (sample < COMPARISON_MIN_SAMPLE) return { status: "insufficient-sample" };
  return { status: "available", value: { sample, punctuality: punctual / sample, meanDelaySeconds: Math.round(signed / sample) } };
}

function lineAggregateMap(rows: readonly RawPostgresRow[]): ReadonlyMap<string, ReturnType<typeof parseAggregateRow>> {
  const result = new Map<string, ReturnType<typeof parseAggregateRow>>();
  for (const row of rows) {
    if (typeof row.line_slug !== "string" || row.line_slug === "") throw new Error("Invalid line history identity");
    if (result.has(row.line_slug)) throw new Error(`Duplicate current line aggregate for ${row.line_slug}`);
    result.set(row.line_slug, parseAggregateRow(row, "api.history_line_day"));
  }
  return result;
}

export interface LiveRepository {
  network(now?: Date): Promise<LiveNetworkResponse>;
  line(slug: string, now?: Date): Promise<LiveContextResponse | null>;
  station(slug: string, now?: Date): Promise<LiveContextResponse | null>;
}

export function createLiveRepository(client: PostgresClient, catalog: CatalogRepository, metadata: MetadataRepository, topology: TopologyRepository): LiveRepository {
  async function sourceAt(): Promise<string | null> {
    const rows = await client.query("SELECT latest_successful_poll_at FROM api.live_health");
    if (rows.length > 1) throw new Error("api.live_health returned multiple rows");
    return parseHealthTimestamp(rows[0]);
  }

  async function vehicles(lineSlug?: string, stationId?: string) {
    const clauses = ["network_slug = $1"];
    const values: unknown[] = [MADRID_NETWORK.slug];
    if (lineSlug !== undefined) { values.push(lineSlug); clauses.push(`line_slug = $${values.length}`); }
    if (stationId !== undefined) { values.push(stationId); clauses.push(`current_station_id = $${values.length}`); }
    return (await client.query(`SELECT * FROM api.active_live_vehicle WHERE ${clauses.join(" AND ")} ORDER BY captured_at DESC, state_key`, values)).map(parseLiveVehicleRow);
  }

  async function comparison(view: "history_line_hour" | "history_station_hour", idColumn: "line_slug" | "station_id", id: string, date: string, hour: number): Promise<Capability<Comparison>> {
    const rows = await client.query(
      `SELECT sum(valid_delay_observations)::bigint AS valid_delay_observations,
        sum(punctual_count)::bigint AS punctual_count,
        sum(signed_delay_sum)::bigint AS signed_delay_sum
       FROM api.${view}
       WHERE network_slug = $1 AND ${idColumn} = $2
         AND service_date < $3::date AND service_date >= $3::date - $4::integer
         AND extract(dow FROM service_date) = extract(dow FROM $3::date)
         AND scheduled_hour = $5`,
      [MADRID_NETWORK.slug, id, date, COMPARISON_LOOKBACK_DAYS, hour],
    );
    return comparisonFromRow(rows[0]);
  }

  return {
    async network(now = new Date()) {
      const date = currentMadridDate(now);
      const [lines, vehicleRows, health, networkRows, lineRows, dayMetadata] = await Promise.all([
        catalog.lines(), vehicles(), sourceAt(),
        client.query("SELECT * FROM api.history_network_day WHERE network_slug = $1 AND service_date = $2::date", [MADRID_NETWORK.slug, date]),
        client.query("SELECT * FROM api.history_line_day WHERE network_slug = $1 AND service_date = $2::date", [MADRID_NETWORK.slug, date]),
        metadata.forDates([date], now),
      ]);
      if (networkRows.length > 1) throw new Error("Duplicate current network aggregate");
      const aggregateRows = networkRows.map((row) => parseAggregateRow(row, "api.history_network_day"));
      const stats = aggregateRows.length === 0 ? emptySummaryStats() : summaryFromAggregateRows(aggregateRows);
      const perLine = lineAggregateMap(lineRows);
      const activeByLine = new Map<string, number>();
      for (const vehicle of vehicleRows) activeByLine.set(vehicle.lineSlug, (activeByLine.get(vehicle.lineSlug) ?? 0) + 1);
      const performance: LinePerformance[] = lines.map((line) => {
        const aggregate = perLine.get(line.slug);
        return { ...line, stats: aggregate === undefined ? { status: "unavailable", reason: "not-provided" } : { status: "available", value: summaryFromAggregateRows([aggregate]) }, activeTrains: activeByLine.get(line.slug) ?? 0 };
      });
      return { meta: liveResponseMeta({ stats, sourceAt: health, activeTrains: vehicleRows.length, serviceDate: date, finalization: dayMetadata.finalization, provenance: algorithmProvenance(aggregateRows.flatMap((row) => row.algorithmVersions)), precision: "mixed", now }), stats, lines: performance };
    },
    async line(slug, now = new Date()) {
      const line = await catalog.line(slug);
      if (line === null) return null;
      const date = currentMadridDate(now);
      const [vehicleRows, health, summaryRows, patterns, dayMetadata, usual] = await Promise.all([
        vehicles(slug), sourceAt(),
        client.query("SELECT * FROM api.history_line_day WHERE network_slug = $1 AND line_slug = $2 AND service_date = $3::date", [MADRID_NETWORK.slug, slug, date]),
        topology.patterns(slug), metadata.forDates([date], now),
        comparison("history_line_hour", "line_slug", slug, date, madridHour(now)),
      ]);
      if (summaryRows.length > 1) throw new Error(`Duplicate current line aggregate for ${slug}`);
      const aggregates = summaryRows.map((row) => parseAggregateRow(row, "api.history_line_day"));
      const stats = aggregates.length === 0 ? emptySummaryStats() : summaryFromAggregateRows(aggregates);
      const trains = vehicleRows.map((row) => liveTrainFromRow(row, line));
      return { meta: liveResponseMeta({ stats, sourceAt: health, activeTrains: trains.length, serviceDate: date, finalization: dayMetadata.finalization, provenance: algorithmProvenance(aggregates.flatMap((row) => row.algorithmVersions)), precision: "mixed", now }), context: line, stats, comparison: usual, patterns, trains };
    },
    async station(slug, now = new Date()) {
      const station = await catalog.station(slug);
      if (station === null) return null;
      const date = currentMadridDate(now);
      const [rows, health, vehicleRows, lines, dayMetadata, usual] = await Promise.all([
        client.query("SELECT * FROM api.history_station_hour WHERE network_slug = $1 AND station_id = $2 AND service_date = $3::date", [MADRID_NETWORK.slug, station.id, date]),
        sourceAt(), vehicles(undefined, station.id), catalog.lines(), metadata.forDates([date], now),
        comparison("history_station_hour", "station_id", station.id, date, madridHour(now)),
      ]);
      const aggregates = rows.map((row) => parseAggregateRow(row, "api.history_station_hour"));
      const stats = summaryFromAggregateRows(aggregates);
      const lineMap = new Map(lines.map((line) => [line.slug, line]));
      const trains = vehicleRows.map((row) => liveTrainFromRow(row, lineMap.get(row.lineSlug) ?? ({ id: `line-${row.lineSlug}`, slug: row.lineSlug, code: row.publicCode, name: { es: row.lineNameEs, en: row.lineNameEn }, color: fallbackLineColor(row.lineSlug) } satisfies LineRef)));
      return { meta: liveResponseMeta({ stats, sourceAt: health, activeTrains: trains.length, serviceDate: date, finalization: dayMetadata.finalization, provenance: algorithmProvenance(aggregates.flatMap((row) => row.algorithmVersions)), precision: "mixed", now }), context: station, stats, comparison: usual, patterns: [], trains };
    },
  };
}
