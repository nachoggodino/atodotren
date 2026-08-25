import type { DelayBucketId, MatrixCell, MatrixJourney, MatrixResponse, MatrixResult, SummaryStats } from "@/lib/domain/contracts";
import { historicalResponseMeta } from "@/lib/domain/data-policy";
import { currentMadridDate, isCalendarDate, offsetCalendarDate } from "@/lib/domain/dates";
import { delayBucketForSeconds, distributionFromCounts, PUNCTUALITY_THRESHOLD_SECONDS } from "@/lib/domain/delay-policy";
import { ValidationError } from "@/lib/domain/errors";
import type { CatalogRepository } from "./catalog-repository";
import type { PostgresClient } from "./client";
import { stationFromCatalogRow } from "./mappers/catalog";
import type { MetadataRepository } from "./metadata-repository";
import { parseMatrixRow } from "./row-parser";

export const MATRIX_RETENTION_DAYS = 30;
const MATRIX_DATABASE_MAX_ROWS = 6000;

function matrixSummary(cells: readonly MatrixCell[]): SummaryStats {
  const delays = cells.flatMap((cell) => cell.delaySeconds === null ? [] : [cell.delaySeconds]);
  const counts: Partial<Record<DelayBucketId, number>> = {};
  for (const delay of delays) { const bucket = delayBucketForSeconds(delay); counts[bucket] = (counts[bucket] ?? 0) + 1; }
  const sorted = [...delays].sort((left, right) => left - right);
  return {
    scheduled: cells.length,
    observed: delays.length,
    punctuality: delays.length === 0 ? null : delays.filter((delay) => delay <= PUNCTUALITY_THRESHOLD_SECONDS).length / delays.length,
    meanDelaySeconds: delays.length === 0 ? null : Math.round(delays.reduce((sum, delay) => sum + delay, 0) / delays.length),
    medianDelaySeconds: sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)] ?? null,
    canceled: cells.filter((cell) => cell.state === "canceled").length,
    missing: cells.filter((cell) => cell.state === "missing_evidence").length,
    distribution: distributionFromCounts(counts),
  };
}

export interface MatrixRepository { get(lineSlug: string, serviceDate: string, now?: Date): Promise<MatrixResult> }

export function createMatrixRepository(client: PostgresClient, catalog: CatalogRepository, metadata: MetadataRepository): MatrixRepository {
  return {
    async get(lineSlug, serviceDate, now = new Date()) {
      if (!isCalendarDate(serviceDate)) throw new ValidationError("Invalid matrix service date", "invalid-service-date");
      const line = await catalog.line(lineSlug);
      if (line === null) return { status: "unavailable", reason: "no-data" };
      const today = currentMadridDate(now);
      if (serviceDate > today) return { status: "unavailable", reason: "no-data" };
      if (serviceDate < offsetCalendarDate(today, -MATRIX_RETENTION_DAYS)) return { status: "unavailable", reason: "retention" };

      const rawRows = await client.query("SELECT * FROM api.recent_line_matrix($1, $2::date, $3::integer)", [lineSlug, serviceDate, MATRIX_DATABASE_MAX_ROWS]);
      if (rawRows.length >= MATRIX_DATABASE_MAX_ROWS) return { status: "failed", reason: "result-too-large" };
      if (rawRows.length === 0) return { status: "unavailable", reason: "no-data" };
      const rows = rawRows.map(parseMatrixRow);
      const stationOrder = new Map<string, { readonly station: ReturnType<typeof stationFromCatalogRow>; readonly order: number }>();
      const journeys = new Map<string, MatrixJourney>();
      const cells: MatrixCell[] = [];
      for (const row of rows) {
        const station = stationFromCatalogRow(row.station);
        const existing = stationOrder.get(station.id);
        if (existing === undefined || row.stopSequence < existing.order) stationOrder.set(station.id, { station, order: row.stopSequence });
        if (!journeys.has(row.journeyId)) journeys.set(row.journeyId, { id: row.journeyId, label: row.sourceTripId, direction: { id: row.direction, headsign: null, from: null, to: null } });
        cells.push({ journeyId: row.journeyId, stationId: station.id, scheduledAt: row.scheduledArrivalAt, reportedAt: row.reportedAt, delaySeconds: row.selectedDelaySeconds, state: row.evidenceState });
      }
      const stats = matrixSummary(cells);
      const dayMetadata = await metadata.forDates([serviceDate], now);
      const matrix: MatrixResponse = {
        meta: historicalResponseMeta({ stats, serviceDate, finalization: dayMetadata.finalization, provenance: { kind: "none" }, precision: "reported", now }),
        line,
        date: serviceDate,
        stations: [...stationOrder.values()].sort((left, right) => left.order - right.order).map((item) => item.station),
        journeys: [...journeys.values()],
        cells,
      };
      return { status: "available", matrix };
    },
  };
}
