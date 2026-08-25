import type { Capability, DirectionDescriptor, HistoryFilters, HistoryResponse, LocalizedSlug, RankingItem } from "@/lib/domain/contracts";
import { algorithmProvenance, historicalResponseMeta } from "@/lib/domain/data-policy";
import { MADRID_NETWORK } from "@/lib/domain/network";
import type { PostgresClient, RawPostgresRow } from "./client";
import type { CatalogRepository } from "./catalog-repository";
import type { MetadataRepository } from "./metadata-repository";
import type { TopologyRepository } from "./topology-repository";
import { directionFallbacks } from "./mappers/catalog";
import { parseAggregateRow } from "./row-parser";
import { historyPointFromRows, summaryFromAggregateRows } from "./stats";

const MIN_LINE_RANKING_SAMPLE = 100;
const RANKING_LIMIT = 8;

type AggregateView = "history_network_day" | "history_network_hour" | "history_line_day" | "history_line_hour" | "history_station_hour";

interface QueryScope {
  readonly view: AggregateView;
  readonly contextClause?: { readonly sql: string; readonly value: string };
  readonly supportsDirection: boolean;
  readonly supportsHour: boolean;
  readonly hasCanceledAndMissing: boolean;
  readonly hasVersionMax: boolean;
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

function rankingQuery(filters: HistoryFilters): { readonly sql: string; readonly values: readonly unknown[] } {
  const useHour = filters.hour !== null || filters.direction !== null;
  const view = useHour ? "api.history_line_hour" : "api.history_line_day";
  const values: unknown[] = [MADRID_NETWORK.slug, filters.from, filters.to];
  const clauses = ["history.network_slug = $1", "history.service_date BETWEEN $2::date AND $3::date"];
  if (filters.weekdays.length > 0) {
    values.push([...filters.weekdays]);
    clauses.push(`extract(dow FROM history.service_date)::integer = ANY($${values.length}::integer[])`);
  }
  if (filters.hour !== null) {
    values.push(filters.hour);
    clauses.push(`history.scheduled_hour = $${values.length}`);
  }
  if (filters.direction !== null) {
    values.push(filters.direction);
    clauses.push(`history.direction = $${values.length}`);
  }
  values.push(MIN_LINE_RANKING_SAMPLE, RANKING_LIMIT);
  const sampleParam = `$${values.length - 1}`;
  const limitParam = `$${values.length}`;
  return {
    values,
    sql: `SELECT history.line_slug, catalog.public_code,
      sum(history.valid_delay_observations)::bigint AS valid_delay_observations,
      sum(history.punctual_count)::bigint AS punctual_count,
      sum(history.signed_delay_sum)::bigint AS signed_delay_sum
      FROM ${view} AS history
      JOIN api.line_catalog AS catalog ON catalog.network_slug = history.network_slug AND catalog.slug = history.line_slug
      WHERE ${clauses.join(" AND ")}
      GROUP BY history.line_slug, catalog.public_code
      HAVING sum(history.valid_delay_observations) >= ${sampleParam}
      ORDER BY (sum(history.signed_delay_sum)::numeric / NULLIF(sum(history.valid_delay_observations), 0)) DESC
      LIMIT ${limitParam}`,
  };
}

function rankingFromRow(row: RawPostgresRow): RankingItem {
  const sample = Number(row.valid_delay_observations);
  const punctual = Number(row.punctual_count);
  const signed = Number(row.signed_delay_sum);
  if (!Number.isSafeInteger(sample) || sample < 0 || !Number.isSafeInteger(punctual) || punctual < 0 || !Number.isSafeInteger(signed)) {
    throw new Error("Invalid ranking aggregate row");
  }
  const id = row.line_slug;
  const label = row.public_code;
  if (typeof id !== "string" || id === "" || typeof label !== "string" || label === "") throw new Error("Invalid ranking identity");
  return {
    id,
    label,
    sample,
    meanDelaySeconds: sample === 0 ? null : Math.round(signed / sample),
    punctuality: sample === 0 ? null : punctual / sample,
  };
}

export interface HistoryRepository {
  network(filters: HistoryFilters): Promise<HistoryResponse>;
  line(slug: string, filters: HistoryFilters): Promise<HistoryResponse | null>;
  station(slug: string, filters: HistoryFilters): Promise<HistoryResponse | null>;
}

export function createHistoryRepository(client: PostgresClient, catalog: CatalogRepository, metadata: MetadataRepository, topology: TopologyRepository): HistoryRepository {
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
    const rows = (await client.query(query.sql, query.values)).map((row) => parseAggregateRow(row, `api.${scope.view}`));
    const stats = summaryFromAggregateRows(rows);
    const serviceDates = rows.map((row) => row.serviceDate);
    const dayMetadata = await metadata.forDates(serviceDates);
    const provenance = algorithmProvenance(rows.flatMap((row) => row.algorithmVersions));
    return {
      meta: historicalResponseMeta({
        stats,
        serviceDate: input.filters.from === input.filters.to ? input.filters.to : null,
        finalization: dayMetadata.finalization,
        provenance,
      }),
      context: { kind: input.kind, label: input.label, id: input.id, slug: input.slug },
      filters: input.filters,
      stats,
      trend: rows.map((row) => historyPointFromRows(row.serviceDate, [row])),
      rankings: input.rankings,
      directions: input.directions,
    };
  }

  return {
    async network(filters) {
      const ranking = rankingQuery(filters);
      const rankingRows = await client.query(ranking.sql, ranking.values);
      const items = rankingRows.map(rankingFromRow);
      return response({
        kind: "network",
        label: MADRID_NETWORK.name.es,
        id: MADRID_NETWORK.slug,
        slug: null,
        queryId: null,
        filters,
        rankings: items.length === 0 ? { status: "insufficient-sample" } : { status: "available", value: items },
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
