import type { DirectionDescriptor, DirectionId, HistoryFilters } from "@/lib/domain/contracts";
import type {
  HistoryAnalysisContext,
  HistoryHeatmapCell,
  HistoryHeatmapDimension,
  HistoryHeatmapRequest,
  HistoryHeatmapResponse,
  HistoryHeatmapType,
  HistoryTrendPoint,
} from "@/lib/domain/history-analysis";
import { historyHeatmapTypeRequiresLine, historyHeatmapTypeUsesSegments } from "@/lib/domain/history-analysis";
import { MADRID_NETWORK } from "@/lib/domain/network";
import type { PostgresClient, RawPostgresRow } from "./client";
import { parseAggregateRow } from "./row-parser";
import { summaryFromAggregateRows } from "./stats";
import type { TopologyRepository } from "./topology-repository";

const MAX_HEATMAP_CELLS = 2500;

type DimensionSpec = {
  readonly source: "station" | "segment";
  readonly xDimension: HistoryHeatmapDimension;
  readonly yDimension: HistoryHeatmapDimension;
  readonly xKeySql: string;
  readonly xLabelSql: string;
  readonly xOrderSql: string;
  readonly yKeySql: string;
  readonly yLabelSql: string;
  readonly yOrderSql: string;
  readonly joins: string;
};

type WhereSql = { readonly clauses: string[]; readonly values: unknown[] };

function integer(value: unknown, field: string, allowNegative = false): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!allowNegative && parsed < 0)) throw new Error(`Invalid ${field}`);
  return parsed;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`Invalid ${field}`);
  return value;
}

function hourTo(filters: HistoryFilters): number | null {
  return filters.hour === null ? null : filters.hourTo ?? filters.hour;
}

function effectiveDirection(filters: HistoryFilters, requested: DirectionId | null): DirectionId | null {
  if (filters.direction !== null && requested !== null && filters.direction !== requested) throw new Error("Heatmap direction cannot widen the page filters");
  return filters.direction ?? requested;
}

function baseWhere(alias: string, context: HistoryAnalysisContext, filters: HistoryFilters, requestedDirection: DirectionId | null, lineSlug: string | null): WhereSql {
  const values: unknown[] = [MADRID_NETWORK.slug, filters.from, filters.to];
  const clauses = [`${alias}.network_slug = $1`, `${alias}.service_date BETWEEN $2::date AND $3::date`];

  if (filters.weekdays.length > 0) {
    values.push([...filters.weekdays]);
    clauses.push(`extract(dow FROM ${alias}.service_date)::integer = ANY($${values.length}::integer[])`);
  }

  if (filters.hour !== null) {
    const end = hourTo(filters);
    if (end === null) throw new Error("Invalid historical hour filter");
    values.push(filters.hour, end);
    clauses.push(`${alias}.scheduled_hour BETWEEN $${values.length - 1} AND $${values.length}`);
  }

  const direction = effectiveDirection(filters, requestedDirection);
  if (direction !== null) {
    values.push(direction);
    clauses.push(`${alias}.direction = $${values.length}`);
  }

  if (context.kind === "line") {
    values.push(context.key);
    clauses.push(`${alias}.line_slug = $${values.length}`);
  } else if (context.kind === "station") {
    if (alias !== "history") throw new Error("Station context is only supported by stop-call heatmaps");
    values.push(context.key);
    clauses.push(`${alias}.station_id = $${values.length}`);
  }

  if (lineSlug !== null && context.kind !== "line") {
    values.push(lineSlug);
    clauses.push(`${alias}.line_slug = $${values.length}`);
  }

  return { clauses, values };
}

function dimensionSpec(type: HistoryHeatmapType): DimensionSpec {
  const hour = { key: "history.scheduled_hour::text", label: "history.scheduled_hour::text || 'h'", order: "history.scheduled_hour::integer" };
  const weekday = { key: "extract(dow FROM history.service_date)::integer::text", label: "extract(dow FROM history.service_date)::integer::text", order: "extract(dow FROM history.service_date)::integer" };
  const station = { key: "history.station_id", label: "station.name_es", order: "dense_rank() OVER (ORDER BY station.name_es, history.station_id)" };
  const line = { key: "history.line_slug", label: "line.public_code", order: "line.display_order" };
  const segment = { key: "history.segment_id", label: "history.from_station_name_es || ' → ' || history.to_station_name_es", order: "dense_rank() OVER (ORDER BY history.segment_id)" };

  switch (type) {
    case "hour-weekday": return { source: "station", xDimension: "hour", yDimension: "weekday", xKeySql: hour.key, xLabelSql: hour.label, xOrderSql: hour.order, yKeySql: weekday.key, yLabelSql: weekday.label, yOrderSql: weekday.order, joins: "" };
    case "station-hour": return { source: "station", xDimension: "hour", yDimension: "station", xKeySql: hour.key, xLabelSql: hour.label, xOrderSql: hour.order, yKeySql: station.key, yLabelSql: station.label, yOrderSql: station.order, joins: "JOIN api.station_catalog AS station ON station.network_slug = history.network_slug AND station.public_id = history.station_id" };
    case "station-weekday": return { source: "station", xDimension: "weekday", yDimension: "station", xKeySql: weekday.key, xLabelSql: weekday.label, xOrderSql: weekday.order, yKeySql: station.key, yLabelSql: station.label, yOrderSql: station.order, joins: "JOIN api.station_catalog AS station ON station.network_slug = history.network_slug AND station.public_id = history.station_id" };
    case "line-hour": return { source: "station", xDimension: "hour", yDimension: "line", xKeySql: hour.key, xLabelSql: hour.label, xOrderSql: hour.order, yKeySql: line.key, yLabelSql: line.label, yOrderSql: line.order, joins: "JOIN api.line_catalog AS line ON line.network_slug = history.network_slug AND line.slug = history.line_slug" };
    case "line-weekday": return { source: "station", xDimension: "weekday", yDimension: "line", xKeySql: weekday.key, xLabelSql: weekday.label, xOrderSql: weekday.order, yKeySql: line.key, yLabelSql: line.label, yOrderSql: line.order, joins: "JOIN api.line_catalog AS line ON line.network_slug = history.network_slug AND line.slug = history.line_slug" };
    case "segment-hour": return { source: "segment", xDimension: "hour", yDimension: "segment", xKeySql: hour.key, xLabelSql: hour.label, xOrderSql: hour.order, yKeySql: segment.key, yLabelSql: segment.label, yOrderSql: segment.order, joins: "" };
    case "segment-weekday": return { source: "segment", xDimension: "weekday", yDimension: "segment", xKeySql: weekday.key, xLabelSql: weekday.label, xOrderSql: weekday.order, yKeySql: segment.key, yLabelSql: segment.label, yOrderSql: segment.order, joins: "" };
  }
}

function aggregateSql(spec: DimensionSpec, where: WhereSql): string {
  const view = spec.source === "segment" ? "api.history_segment_hour" : "api.history_station_hour";
  return `
    WITH filtered AS (
      SELECT ${spec.xKeySql} AS x_key, ${spec.xLabelSql} AS x_label, ${spec.xOrderSql} AS x_order,
        ${spec.yKeySql} AS y_key, ${spec.yLabelSql} AS y_label, ${spec.yOrderSql} AS y_order,
        history.service_date, history.scheduled_opportunities, history.valid_delay_observations,
        history.punctual_count, history.canceled_count, history.missing_evidence_count,
        history.signed_delay_sum, history.delay_histogram,
        history.aggregate_algorithm_version, history.aggregate_algorithm_version_max
      FROM ${view} AS history
      ${spec.joins}
      WHERE ${where.clauses.join(" AND ")}
    ), scalar AS (
      SELECT x_key, x_label, min(x_order)::integer AS x_order, y_key, y_label, min(y_order)::integer AS y_order,
        min(service_date)::date AS service_date,
        sum(scheduled_opportunities)::bigint AS scheduled_opportunities,
        sum(valid_delay_observations)::bigint AS valid_delay_observations,
        sum(punctual_count)::bigint AS punctual_count,
        sum(canceled_count)::bigint AS canceled_count,
        sum(missing_evidence_count)::bigint AS missing_evidence_count,
        sum(signed_delay_sum)::bigint AS signed_delay_sum,
        min(aggregate_algorithm_version) AS aggregate_algorithm_version,
        max(aggregate_algorithm_version_max) AS aggregate_algorithm_version_max
      FROM filtered
      GROUP BY x_key, x_label, y_key, y_label
    ), histogram AS (
      SELECT x_key, y_key, array_agg(bucket_total ORDER BY ordinality) AS delay_histogram
      FROM (
        SELECT filtered.x_key, filtered.y_key, bucket.ordinality, sum(bucket.value)::bigint AS bucket_total
        FROM filtered
        CROSS JOIN LATERAL unnest(filtered.delay_histogram) WITH ORDINALITY AS bucket(value, ordinality)
        GROUP BY filtered.x_key, filtered.y_key, bucket.ordinality
      ) AS buckets
      GROUP BY x_key, y_key
    )
    SELECT scalar.*, histogram.delay_histogram
    FROM scalar
    JOIN histogram USING (x_key, y_key)
    ORDER BY scalar.y_order, scalar.x_order
    LIMIT ${MAX_HEATMAP_CELLS + 1}`;
}

function heatmapCell(row: RawPostgresRow, segment: boolean): HistoryHeatmapCell {
  const aggregate = parseAggregateRow(row, "history heatmap aggregate");
  const stats = summaryFromAggregateRows([aggregate]);
  return {
    x: stringValue(row.x_key, "heatmap x key"),
    xLabel: stringValue(row.x_label, "heatmap x label"),
    xOrder: integer(row.x_order, "heatmap x order"),
    y: stringValue(row.y_key, "heatmap y key"),
    yLabel: stringValue(row.y_label, "heatmap y label"),
    yOrder: integer(row.y_order, "heatmap y order"),
    scheduled: stats.scheduled,
    observed: stats.observed,
    punctuality: stats.punctuality,
    meanDelaySeconds: stats.meanDelaySeconds,
    medianDelaySeconds: stats.medianDelaySeconds,
    cancellationRate: stats.scheduled === 0 || stats.canceled === null ? null : stats.canceled / stats.scheduled,
    coverage: stats.scheduled === 0 ? null : stats.observed / stats.scheduled,
    addedDelaySeconds: segment ? stats.meanDelaySeconds : null,
  };
}

function validateRequest(request: HistoryHeatmapRequest): void {
  if (historyHeatmapTypeUsesSegments(request.type) && request.context.kind === "station") throw new Error("Segment heatmaps do not apply to station context");
  if (request.context.kind === "line" && request.lineSlug !== null && request.lineSlug !== request.context.key) throw new Error("Heatmap line cannot escape line page context");
  if (historyHeatmapTypeRequiresLine(request.type) && request.context.kind === "network" && request.lineSlug === null) throw new Error("This heatmap requires a line");
  if ((request.type === "line-hour" || request.type === "line-weekday") && request.context.kind === "line") throw new Error("Line comparison does not apply to line context");
}

export interface HistoryAnalysisRepository {
  trend(context: HistoryAnalysisContext, filters: HistoryFilters): Promise<readonly HistoryTrendPoint[]>;
  heatmap(request: HistoryHeatmapRequest): Promise<HistoryHeatmapResponse>;
  lineDirections(slug: string): Promise<readonly DirectionDescriptor[]>;
}

export function createHistoryAnalysisRepository(client: PostgresClient, topology: TopologyRepository): HistoryAnalysisRepository {
  return {
    async trend(context, filters) {
      const where = baseWhere("history", context, filters, null, null);
      const rows = await client.query(
        `WITH filtered AS (
          SELECT history.service_date, history.scheduled_opportunities, history.valid_delay_observations,
            history.punctual_count, history.canceled_count, history.missing_evidence_count,
            history.signed_delay_sum, history.delay_histogram,
            history.aggregate_algorithm_version, history.aggregate_algorithm_version_max
          FROM api.history_station_hour AS history
          WHERE ${where.clauses.join(" AND ")}
        ), scalar AS (
          SELECT service_date,
            sum(scheduled_opportunities)::bigint AS scheduled_opportunities,
            sum(valid_delay_observations)::bigint AS valid_delay_observations,
            sum(punctual_count)::bigint AS punctual_count,
            sum(canceled_count)::bigint AS canceled_count,
            sum(missing_evidence_count)::bigint AS missing_evidence_count,
            sum(signed_delay_sum)::bigint AS signed_delay_sum,
            min(aggregate_algorithm_version) AS aggregate_algorithm_version,
            max(aggregate_algorithm_version_max) AS aggregate_algorithm_version_max
          FROM filtered GROUP BY service_date
        ), histogram AS (
          SELECT service_date, array_agg(bucket_total ORDER BY ordinality) AS delay_histogram
          FROM (
            SELECT filtered.service_date, bucket.ordinality, sum(bucket.value)::bigint AS bucket_total
            FROM filtered CROSS JOIN LATERAL unnest(filtered.delay_histogram) WITH ORDINALITY AS bucket(value, ordinality)
            GROUP BY filtered.service_date, bucket.ordinality
          ) AS buckets GROUP BY service_date
        )
        SELECT scalar.*, histogram.delay_histogram
        FROM scalar JOIN histogram USING (service_date)
        ORDER BY service_date`,
        where.values,
      );
      return rows.map((row) => {
        const aggregate = parseAggregateRow(row, "history trend aggregate");
        const stats = summaryFromAggregateRows([aggregate]);
        return {
          date: aggregate.serviceDate,
          scheduled: stats.scheduled,
          observed: stats.observed,
          punctuality: stats.punctuality,
          meanDelaySeconds: stats.meanDelaySeconds,
          medianDelaySeconds: stats.medianDelaySeconds,
          delayedStops: Math.max(0, aggregate.observed - aggregate.punctual),
          coverage: stats.scheduled === 0 ? null : stats.observed / stats.scheduled,
        } satisfies HistoryTrendPoint;
      });
    },
    async heatmap(request) {
      validateRequest(request);
      const spec = dimensionSpec(request.type);
      const alias = "history";
      const lineSlug = request.context.kind === "line" ? request.context.key : request.lineSlug;
      const where = baseWhere(alias, request.context, request.filters, request.direction, lineSlug);
      const rows = await client.query(aggregateSql(spec, where), where.values);
      if (rows.length > MAX_HEATMAP_CELLS) throw new Error("Heatmap result exceeds the bounded cell limit");
      return {
        type: request.type,
        xDimension: spec.xDimension,
        yDimension: spec.yDimension,
        lineSlug,
        direction: effectiveDirection(request.filters, request.direction),
        cells: rows.map((row) => heatmapCell(row, spec.source === "segment")),
      };
    },
    lineDirections: (slug) => topology.directions(slug),
  };
}
