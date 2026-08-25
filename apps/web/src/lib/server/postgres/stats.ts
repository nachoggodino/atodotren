import type { DelayBucket, HistoryPoint, SummaryStats } from "@/lib/domain/contracts";
import { delayBucketForSeconds, distributionFromCounts, emptyDelayDistribution } from "@/lib/domain/delay-policy";
import type { AggregateRow } from "./row-parser";

const HISTOGRAM_BIN_COUNT = 72;

function histogramRepresentativeSeconds(index: number): number {
  if (index === 0) return -315;
  if (index === HISTOGRAM_BIN_COUNT - 1) return 1815;
  return -300 + (index - 1) * 30 + 15;
}

export function mergeHistograms(histograms: readonly (readonly number[])[]): readonly number[] {
  if (histograms.length === 0) return Array.from({ length: HISTOGRAM_BIN_COUNT }, () => 0);
  if (histograms.some((values) => values.length !== HISTOGRAM_BIN_COUNT)) throw new Error("Unexpected h30-v1 histogram length");
  return Array.from({ length: HISTOGRAM_BIN_COUNT }, (_, index) => histograms.reduce((sum, values) => sum + (values[index] ?? 0), 0));
}

export function medianFromHistogram(values: readonly number[]): number | null {
  if (values.length !== HISTOGRAM_BIN_COUNT) throw new Error("Unexpected h30-v1 histogram length");
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total === 0) return null;
  const target = total / 2;
  let seen = 0;
  for (let index = 0; index < values.length; index += 1) {
    seen += values[index] ?? 0;
    if (seen >= target) return histogramRepresentativeSeconds(index);
  }
  return null;
}

export function normalizeHistogram(values: readonly number[]): readonly DelayBucket[] {
  if (values.length !== HISTOGRAM_BIN_COUNT) throw new Error("Unexpected h30-v1 histogram length");
  const counts: Record<string, number> = {};
  for (let index = 0; index < values.length; index += 1) {
    const bucket = delayBucketForSeconds(histogramRepresentativeSeconds(index));
    counts[bucket] = (counts[bucket] ?? 0) + (values[index] ?? 0);
  }
  return distributionFromCounts(counts);
}

export function emptySummaryStats(): SummaryStats {
  return {
    scheduled: 0,
    observed: 0,
    punctuality: null,
    meanDelaySeconds: null,
    medianDelaySeconds: null,
    canceled: null,
    missing: null,
    distribution: emptyDelayDistribution(),
  };
}

function sumNullable(rows: readonly AggregateRow[], key: "canceled" | "missing"): number | null {
  if (rows.some((row) => row[key] === null)) return null;
  return rows.reduce((sum, row) => sum + (row[key] ?? 0), 0);
}

export function summaryFromAggregateRows(rows: readonly AggregateRow[]): SummaryStats {
  if (rows.length === 0) return emptySummaryStats();
  const scheduled = rows.reduce((sum, row) => sum + row.scheduled, 0);
  const observed = rows.reduce((sum, row) => sum + row.observed, 0);
  const punctual = rows.reduce((sum, row) => sum + row.punctual, 0);
  const signedDelaySum = rows.reduce((sum, row) => sum + row.signedDelaySum, 0);
  const histogram = mergeHistograms(rows.map((row) => row.histogram));
  return {
    scheduled,
    observed,
    punctuality: observed === 0 ? null : punctual / observed,
    meanDelaySeconds: observed === 0 ? null : Math.round(signedDelaySum / observed),
    medianDelaySeconds: medianFromHistogram(histogram),
    canceled: sumNullable(rows, "canceled"),
    missing: sumNullable(rows, "missing"),
    distribution: normalizeHistogram(histogram),
  };
}

export function historyPointFromRows(date: string, rows: readonly AggregateRow[]): HistoryPoint {
  const stats = summaryFromAggregateRows(rows);
  return {
    date,
    scheduled: stats.scheduled,
    observed: stats.observed,
    punctuality: stats.punctuality,
    meanDelaySeconds: stats.meanDelaySeconds,
    coverage: stats.scheduled === 0 ? null : stats.observed / stats.scheduled,
  };
}
