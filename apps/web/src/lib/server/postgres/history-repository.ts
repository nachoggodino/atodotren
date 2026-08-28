import type { Capability, DirectionDescriptor, HistoryFilters, HistoryInsights, HistoryResponse, HourWeekdayItem, LocalizedSlug, RankingItem, SegmentDelayItem, VolumeReliabilityItem } from "@/lib/domain/contracts";
import { algorithmProvenance, historicalResponseMeta } from "@/lib/domain/data-policy";
import { MADRID_NETWORK } from "@/lib/domain/network";
import type { CatalogRepository } from "./catalog-repository";
import type { PostgresClient, RawPostgresRow } from "./client";
import { directionFallbacks } from "./mappers/catalog";
import type { MetadataRepository } from "./metadata-repository";
import { parseAggregateRow } from "./row-parser";
import { historyPointFromRows, summaryFromAggregateRows } from "./stats";
import type { TopologyRepository } from "./topology-repository";

const MIN_RANKING_SAMPLE = 100;
const RANKING_LIMIT = 8;
const HOUR_LIMIT = 6;

type AggregateView = "history_network_day" | "history_network_hour" | "history_line_day" | "history_line_hour" | "history_station_hour";

interface QueryScope {
  readonly view: AggregateView;
  readonly contextClause?: { readonly sql: string; readonly value: string };
  readonly supportsDirection: boolean;
  readonly supportsHour: boolean;
  readonly hasCanceledAndMissing: boolean;
  readonly hasVersionMax: boolean;
}

interface FilterSql {
  readonly clauses: string[];
  readonly values: unknown[];
}

function filteredRange(filters: HistoryFilters, prefix: string, initialValues: unknown[] = [MADRID_NETWORK.slug]): FilterSql {
  const values = [...initialValues, filters.from, filters.to];
  const dateStart = `$${values.length - 1}`;
  const dateEnd = `$${values.length}`;
  const clauses = [`${prefix}.network_slug = $1`, `${prefix}.service_date BETWEEN ${dateStart}::date AND ${dateEnd}::date`];
  if (filters.weekdays.length > 0) {
    values.push([...filters.weekdays]);
    clauses.push(`extract(dow FROM ${prefix}.service_date)::integer = ANY($${values.length}::integer[])`);
  }
  return { clauses, values };
}

function aggregateQuery(scope: QueryScope, filters: HistoryFilters): { readonly sql: string; readonly values: readonly unknown[] } {
  const values: unknown[] = [MADRID_NETWORK.slug, filters.from, filters.to];
  const clauses = ["network_slug = $1", "service_date BETWEEN $2::date AND $3::date"];
  if (scope.contextClause !== undefined) {
    values.push(scope.contextClause.value);
    clauses.push(scope.contextClause.sql.replace("?", `$${values.length}`));
  }
  if (filters.weekdays.length > 0) {
    values.push([...filters.weekdays]);
    clauses.push(`extract(dow FROM service_date)::integer = ANY($${values.length}::integer[])`);
  }
  if (filters.hour !== null) {
    if (!scope.supportsHour) throw new Error(`${scope.view} cannot apply an hour filter`);
    values.push(filters.hour);
    clauses.push(`scheduled_hour = $${values.length}`);
  }
  if (filters.direction !== null) {
    if (!scope.supportsDirection) throw new Error(`${scope.view} cannot apply a direction filter`);
    values.push(filters.direction);
    clauses.push(`direction = $${values.length}`);
  }
  const canceled = scope.hasCanceledAndMissing ? "sum(canceled_count)::bigint" : "NULL::bigint";
  const missing = scope.hasCanceledAndMissing ? "sum(missing_evidence_count)::bigint" : "NULL::bigint";
  const versionMax = scope.hasVersionMax ? "aggregate_algorithm_version_max" : "aggregate_algorithm_version";
  return {
    values,
    sql: `
      WITH filtered AS (
        SELECT service_date, scheduled_opportunities, valid_delay_observations, punctual_count,
          signed_delay_sum, ${scope.hasCanceledAndMissing ? "canceled_count, missing_evidence_count," : ""}
          delay_histogram, aggregate_algorithm_version, ${versionMax} AS aggregate_algorithm_version_max
        FROM api.${scope.view}
        WHERE ${clauses.join(" AND ")}
      ), scalar AS (
        SELECT service_date,
          sum(scheduled_opportunities)::bigint AS scheduled_opportunities,
          sum(valid_delay_observations)::bigint AS valid_delay_observations,
          sum(punctual_count)::bigint AS punctual_count,
          sum(signed_delay_sum)::bigint AS signed_delay_sum,
          ${canceled} AS canceled_count,
          ${missing} AS missing_evidence_count,
          min(aggregate_algorithm_version) AS aggregate_algorithm_version,
          max(aggregate_algorithm_version_max) AS aggregate_algorithm_version_max
        FROM filtered
        GROUP BY service_date
      ), histogram AS (
        SELECT service_date, array_agg(bucket_total ORDER BY ordinality) AS delay_histogram
        FROM (
          SELECT filtered.service_date, bucket.ordinality, sum(bucket.value)::bigint AS bucket_total
          FROM filtered
          CROSS JOIN LATERAL unnest(filtered.delay_histogram) WITH ORDINALITY AS bucket(value, ordinality)
          GROUP BY filtered.service_date, bucket.ordinality
        ) AS bucket_totals
        GROUP BY service_date
      )
      SELECT scalar.*, histogram.delay_histogram
      FROM scalar
      JOIN histogram USING (service_date)
      ORDER BY service_date`,
  };
}

function scopeFor(kind: "network" | "line" | "station", id: string | null, filters: HistoryFilters): QueryScope {
  const needsHour = filters.hour !== null || filters.direction !== null;
  if (kind === "network") return {
    view: needsHour ? "history_network_hour" : "history_network_day",
    supportsDirection: needsHour,
    supportsHour: needsHour,
    hasCanceledAndMissing: needsHour,
    hasVersionMax: needsHour,
  };
  if (kind === "line") {
    if (id === null) throw new Error("Line history requires a line slug");
    return {
      view: needsHour ? "history_line_hour" : "history_line_day",
      contextClause: { sql: "line_slug = ?", value: id },
      supportsDirection: needsHour,
      supportsHour: needsHour,
      hasCanceledAndMissing: !needsHour,
      hasVersionMax: needsHour,
    };
  }
  if (id === null) throw new Error("Station history requires a station id");
  return {
    view: "history_station_hour",
    contextClause: { sql: "station_id = ?", value: id },
    supportsDirection: true,
    supportsHour: true,
    hasCanceledAndMissing: true,
    hasVersionMax: true,
  };
}

function strictInteger(value: unknown, field: string, allowNegative = false): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!allowNegative && parsed < 0)) throw new Error(`Invalid ${field} aggregate`);
  return parsed;
}

function rankingFromAggregate(row: RawPostgresRow, idField: string, labelField: string): RankingItem {
  const sample = strictInteger(row.valid_delay_observations, "ranking sample");
  const punctual = strictInteger(row.punctual_count, "ranking punctual count");
  const signed = strictInteger(row.signed_delay_sum, "ranking signed delay", true);
  const id = row[idField];
  const label = row[labelField];
  if (typeof id !== "string" || id === "" || typeof label !== "string" || label === "") throw new Error("Invalid ranking identity");
  return { id, label, sample, meanDelaySeconds: sample === 0 ? null : Math.round(signed / sample), punctuality: sample === 0 ? null : punctual / sample };
}

function availableOrSample<T>(items: readonly T[]): Capability<readonly T[]> {
  return items.length === 0 ? { status: "insufficient-sample" } : { status: "available", value: items };
}

function withDimensionFilters(base: FilterSql, filters: HistoryFilters, prefix: string, includeHour: boolean): FilterSql {
  const values = [...base.values];
  const clauses = [...base.clauses];
  if (includeHour && filters.hour !== null) {
    values.push(filters.hour);
    clauses.push(`${prefix}.scheduled_hour = $${values.length}`);
  }
  if (filters.direction !== null) {
    values.push(filters.direction);
    clauses.push(`${prefix}.direction = $${values.length}`);
  }
  return { clauses, values };
}

function rankingQuery(filters: HistoryFilters): { readonly sql: string; readonly values: readonly unknown[] } {
  const useHour = filters.hour !== null || filters.direction !== null;
  const view = useHour ? "api.history_line_hour" : "api.history_line_day";
  const base = filteredRange(filters, "history");
  const scoped = withDimensionFilters(base, filters, "history", true);
  const values = [...scoped.values, MIN_RANKING_SAMPLE, RANKING_LIMIT];
  return {
    values,
    sql: `SELECT history.line_slug, catalog.public_code,
      sum(history.valid_delay_observations)::bigint AS valid_delay_observations,
      sum(history.punctual_count)::bigint AS punctual_count,
      sum(history.signed_delay_sum)::bigint AS signed_delay_sum
      FROM ${view} AS history
      JOIN api.line_catalog AS catalog ON catalog.network_slug = history.network_slug AND catalog.slug = history.line_slug
      WHERE ${scoped.clauses.join(" AND ")}
      GROUP BY history.line_slug, catalog.public_code
      HAVING sum(history.valid_delay_observations) >= $${values.length - 1}
      ORDER BY (sum(history.signed_delay_sum)::numeric / NULLIF(sum(history.valid_delay_observations), 0)) DESC
      LIMIT $${values.length}`,
  };
}

async function stationRanking(client: PostgresClient, kind: "network" | "line" | "station", queryId: string | null, filters: HistoryFilters): Promise<Capability<readonly RankingItem[]>> {
  if (kind === "station") return { status: "unavailable", reason: "not-supported" };
  const base = filteredRange(filters, "history");
  const scoped = withDimensionFilters(base, filters, "history", true);
  if (kind === "line") {
    scoped.values.push(queryId);
    scoped.clauses.push(`history.line_slug = $${scoped.values.length}`);
  }
  const values = [...scoped.values, MIN_RANKING_SAMPLE, RANKING_LIMIT];
  const rows = await client.query(
    `SELECT history.station_id, catalog.name_es AS station_name,
      sum(history.valid_delay_observations)::bigint AS valid_delay_observations,
      sum(history.punctual_count)::bigint AS punctual_count,
      sum(history.signed_delay_sum)::bigint AS signed_delay_sum
     FROM api.history_station_hour AS history
     JOIN api.station_catalog AS catalog ON catalog.network_slug = history.network_slug AND catalog.public_id = history.station_id
     WHERE ${scoped.clauses.join(" AND ")}
     GROUP BY history.station_id, catalog.name_es
     HAVING sum(history.valid_delay_observations) >= $${values.length - 1}
     ORDER BY (sum(history.signed_delay_sum)::numeric / NULLIF(sum(history.valid_delay_observations), 0)) DESC
     LIMIT $${values.length}`,
    values,
  );
  return availableOrSample(rows.map((row) => rankingFromAggregate(row, "station_id", "station_name")));
}

function hourlyView(kind: "network" | "line" | "station"): "history_network_hour" | "history_line_hour" | "history_station_hour" {
  return kind === "network" ? "history_network_hour" : kind === "line" ? "history_line_hour" : "history_station_hour";
}

async function worstHours(client: PostgresClient, kind: "network" | "line" | "station", queryId: string | null, filters: HistoryFilters): Promise<Capability<readonly RankingItem[]>> {
  const view = hourlyView(kind);
  const base = filteredRange(filters, "history");
  const scoped = withDimensionFilters(base, { ...filters, hour: null }, "history", false);
  if (kind === "line") {
    scoped.values.push(queryId);
    scoped.clauses.push(`history.line_slug = $${scoped.values.length}`);
  } else if (kind === "station") {
    scoped.values.push(queryId);
    scoped.clauses.push(`history.station_id = $${scoped.values.length}`);
  }
  const values = [...scoped.values, MIN_RANKING_SAMPLE, HOUR_LIMIT];
  const rows = await client.query(
    `SELECT history.scheduled_hour::text AS hour_id,
      lpad(history.scheduled_hour::text, 2, '0') || ':00' AS hour_label,
      sum(history.valid_delay_observations)::bigint AS valid_delay_observations,
      sum(history.punctual_count)::bigint AS punctual_count,
      sum(history.signed_delay_sum)::bigint AS signed_delay_sum
     FROM api.${view} AS history
     WHERE ${scoped.clauses.join(" AND ")}
     GROUP BY history.scheduled_hour
     HAVING sum(history.valid_delay_observations) >= $${values.length - 1}
     ORDER BY (sum(history.signed_delay_sum)::numeric / NULLIF(sum(history.valid_delay_observations), 0)) DESC
     LIMIT $${values.length}`,
    values,
  );
  return availableOrSample(rows.map((row) => rankingFromAggregate(row, "hour_id", "hour_label")));
}

async function hourWeekday(client: PostgresClient, kind: "network" | "line" | "station", queryId: string | null, filters: HistoryFilters): Promise<Capability<readonly HourWeekdayItem[]>> {
  const view = hourlyView(kind);
  const base = filteredRange(filters, "history");
  const scoped = withDimensionFilters(base, { ...filters, hour: null }, "history", false);
  if (kind === "line") {
    scoped.values.push(queryId);
    scoped.clauses.push(`history.line_slug = $${scoped.values.length}`);
  } else if (kind === "station") {
    scoped.values.push(queryId);
    scoped.clauses.push(`history.station_id = $${scoped.values.length}`);
  }
  const rows = await client.query(
    `SELECT extract(dow FROM history.service_date)::integer AS weekday, history.scheduled_hour,
      sum(history.scheduled_opportunities)::bigint AS scheduled_opportunities,
      sum(history.valid_delay_observations)::bigint AS valid_delay_observations,
      sum(history.signed_delay_sum)::bigint AS signed_delay_sum
     FROM api.${view} AS history
     WHERE ${scoped.clauses.join(" AND ")}
     GROUP BY extract(dow FROM history.service_date)::integer, history.scheduled_hour
     ORDER BY weekday, history.scheduled_hour`,
    scoped.values,
  );
  const items = rows.map<HourWeekdayItem>((row) => {
    const weekday = strictInteger(row.weekday, "weekday");
    const hour = strictInteger(row.scheduled_hour, "scheduled hour");
    const scheduled = strictInteger(row.scheduled_opportunities, "scheduled opportunities");
    const sample = strictInteger(row.valid_delay_observations, "observed sample");
    const signed = strictInteger(row.signed_delay_sum, "signed delay", true);
    return { weekday, hour, scheduled, sample, meanDelaySeconds: sample === 0 ? null : Math.round(signed / sample), coverage: scheduled === 0 ? null : sample / scheduled };
  });
  return availableOrSample(items);
}

async function volumeReliability(client: PostgresClient, kind: "network" | "line" | "station", queryId: string | null, filters: HistoryFilters): Promise<Capability<readonly VolumeReliabilityItem[]>> {
  const base = filteredRange(filters, "history");
  const scoped = withDimensionFilters(base, filters, "history", true);
  let view: string;
  let idSql: string;
  let labelSql: string;
  let join = "";
  if (kind === "network") {
    view = filters.hour !== null || filters.direction !== null ? "api.history_line_hour" : "api.history_line_day";
    idSql = "history.line_slug";
    labelSql = "catalog.public_code";
    join = "JOIN api.line_catalog AS catalog ON catalog.network_slug = history.network_slug AND catalog.slug = history.line_slug";
  } else if (kind === "line") {
    view = "api.history_station_hour";
    idSql = "history.station_id";
    labelSql = "catalog.name_es";
    join = "JOIN api.station_catalog AS catalog ON catalog.network_slug = history.network_slug AND catalog.public_id = history.station_id";
    scoped.values.push(queryId);
    scoped.clauses.push(`history.line_slug = $${scoped.values.length}`);
  } else {
    view = "api.history_station_hour";
    idSql = "history.line_slug";
    labelSql = "catalog.public_code";
    join = "JOIN api.line_catalog AS catalog ON catalog.network_slug = history.network_slug AND catalog.slug = history.line_slug";
    scoped.values.push(queryId);
    scoped.clauses.push(`history.station_id = $${scoped.values.length}`);
  }
  const rows = await client.query(
    `SELECT ${idSql} AS entity_id, ${labelSql} AS entity_label,
      sum(history.scheduled_opportunities)::bigint AS scheduled_opportunities,
      sum(history.valid_delay_observations)::bigint AS valid_delay_observations,
      sum(history.punctual_count)::bigint AS punctual_count,
      sum(history.signed_delay_sum)::bigint AS signed_delay_sum
     FROM ${view} AS history ${join}
     WHERE ${scoped.clauses.join(" AND ")}
     GROUP BY ${idSql}, ${labelSql}
     ORDER BY sum(history.scheduled_opportunities) DESC
     LIMIT 40`,
    scoped.values,
  );
  const items = rows.map<VolumeReliabilityItem>((row) => {
    const id = row.entity_id;
    const label = row.entity_label;
    if (typeof id !== "string" || id === "" || typeof label !== "string" || label === "") throw new Error("Invalid volume/reliability identity");
    const scheduled = strictInteger(row.scheduled_opportunities, "scheduled opportunities");
    const sample = strictInteger(row.valid_delay_observations, "observed sample");
    const punctual = strictInteger(row.punctual_count, "punctual count");
    const signed = strictInteger(row.signed_delay_sum, "signed delay", true);
    return { id, label, scheduled, sample, meanDelaySeconds: sample === 0 ? null : Math.round(signed / sample), punctuality: sample === 0 ? null : punctual / sample, coverage: scheduled === 0 ? null : sample / scheduled };
  });
  return availableOrSample(items);
}

async function segmentDelays(client: PostgresClient, kind: "network" | "line" | "station", queryId: string | null, filters: HistoryFilters): Promise<Capability<readonly SegmentDelayItem[]>> {
  if (kind !== "line" || queryId === null) return { status: "unavailable", reason: "not-supported" };
  const base = filteredRange(filters, "history");
  const scoped = withDimensionFilters(base, filters, "history", true);
  scoped.values.push(queryId);
  scoped.clauses.push(`history.line_slug = $${scoped.values.length}`);
  const rows = await client.query(
    `SELECT history.segment_id, history.direction,
      history.from_station_name_es || ' → ' || history.to_station_name_es AS segment_label,
      sum(history.valid_delay_observations)::bigint AS valid_delay_observations,
      sum(history.signed_delay_sum)::bigint AS signed_delay_sum
     FROM api.history_segment_hour AS history
     WHERE ${scoped.clauses.join(" AND ")}
     GROUP BY history.segment_id, history.direction, history.from_station_name_es, history.to_station_name_es
     HAVING sum(history.valid_delay_observations) >= $${scoped.values.length + 1}
     ORDER BY (sum(history.signed_delay_sum)::numeric / NULLIF(sum(history.valid_delay_observations), 0)) DESC
     LIMIT $${scoped.values.length + 2}`,
    [...scoped.values, MIN_RANKING_SAMPLE, RANKING_LIMIT * 2],
  );
  const items = rows.map<SegmentDelayItem>((row) => {
    const id = row.segment_id;
    const label = row.segment_label;
    const direction = strictInteger(row.direction, "segment direction");
    if (direction !== 0 && direction !== 1) throw new Error("Invalid segment direction");
    if (typeof id !== "string" || id === "" || typeof label !== "string" || label === "") throw new Error("Invalid segment identity");
    const sample = strictInteger(row.valid_delay_observations, "segment sample");
    const signed = strictInteger(row.signed_delay_sum, "segment signed delay", true);
    return { id: `${id}-${direction}`, label, direction, sample, addedDelaySeconds: sample === 0 ? null : Math.round(signed / sample) };
  });
  return availableOrSample(items);
}

export interface HistoryRepository {
  network(filters: HistoryFilters): Promise<HistoryResponse>;
  line(slug: string, filters: HistoryFilters): Promise<HistoryResponse | null>;
  station(slug: string, filters: HistoryFilters): Promise<HistoryResponse | null>;
}

export function createHistoryRepository(client: PostgresClient, catalog: CatalogRepository, metadata: MetadataRepository, topology: TopologyRepository): HistoryRepository {
  async function insights(kind: "network" | "line" | "station", queryId: string | null, filters: HistoryFilters): Promise<HistoryInsights> {
    const [stations, hours, weekdayHours, volume, segments] = await Promise.all([
      stationRanking(client, kind, queryId, filters),
      worstHours(client, kind, queryId, filters),
      hourWeekday(client, kind, queryId, filters),
      volumeReliability(client, kind, queryId, filters),
      segmentDelays(client, kind, queryId, filters),
    ]);
    return { stations, hours, hourWeekday: weekdayHours, volumeReliability: volume, segments, scheduleSlots: { status: "unavailable", reason: "not-supported" } };
  }

  async function response(input: {
    readonly kind: "network" | "line" | "station";
    readonly label: string;
    readonly id: string;
    readonly slug: LocalizedSlug | null;
    readonly queryId: string | null;
    readonly filters: HistoryFilters;
    readonly rankings: Capability<readonly RankingItem[]>;
    readonly directions: readonly DirectionDescriptor[];
  }): Promise<HistoryResponse> {
    const scope = scopeFor(input.kind, input.queryId, input.filters);
    const query = aggregateQuery(scope, input.filters);
    const [rawRows, detailInsights] = await Promise.all([
      client.query(query.sql, query.values),
      insights(input.kind, input.queryId, input.filters),
    ]);
    const rows = rawRows.map((row) => parseAggregateRow(row, `api.${scope.view}`));
    const stats = summaryFromAggregateRows(rows);
    const serviceDates = rows.map((row) => row.serviceDate);
    const dayMetadata = await metadata.forDates(serviceDates);
    const provenance = algorithmProvenance(rows.flatMap((row) => row.algorithmVersions));
    return {
      meta: historicalResponseMeta({ stats, serviceDate: input.filters.from === input.filters.to ? input.filters.to : null, finalization: dayMetadata.finalization, provenance }),
      context: { kind: input.kind, label: input.label, id: input.id, slug: input.slug },
      filters: input.filters,
      stats,
      trend: rows.map((row) => historyPointFromRows(row.serviceDate, [row])),
      rankings: input.rankings,
      insights: detailInsights,
      directions: input.directions,
    };
  }

  return {
    async network(filters) {
      const ranking = rankingQuery(filters);
      const rankingRows = await client.query(ranking.sql, ranking.values);
      const items = rankingRows.map((row) => rankingFromAggregate(row, "line_slug", "public_code"));
      return response({
        kind: "network",
        label: MADRID_NETWORK.name.es,
        id: MADRID_NETWORK.slug,
        slug: null,
        queryId: null,
        filters,
        rankings: availableOrSample(items),
        directions: directionFallbacks(),
      });
    },
    async line(slug, filters) {
      const line = await catalog.line(slug);
      if (line === null) return null;
      const directions = await topology.directions(slug);
      return response({
        kind: "line",
        label: line.code,
        id: line.id,
        slug: { es: line.slug, en: line.slug },
        queryId: slug,
        filters,
        rankings: { status: "unavailable", reason: "not-supported" },
        directions: directions.length === 0 ? directionFallbacks() : directions,
      });
    },
    async station(slug, filters) {
      const station = await catalog.station(slug);
      if (station === null) return null;
      return response({
        kind: "station",
        label: station.name.es,
        id: station.id,
        slug: station.slug,
        queryId: station.id,
        filters,
        rankings: { status: "unavailable", reason: "not-supported" },
        directions: directionFallbacks(),
      });
    },
  };
}
