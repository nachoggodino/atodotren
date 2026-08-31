import type { DirectionId, HistoryFilters } from "./contracts";

export type HistoryAnalysisContextKind = "network" | "line" | "station";

export interface HistoryAnalysisContext {
  readonly kind: HistoryAnalysisContextKind;
  /** Network slug, line slug, or public station id depending on kind. */
  readonly key: string;
}

export interface HistoryTrendPoint {
  readonly date: string;
  readonly scheduled: number;
  readonly observed: number;
  readonly punctuality: number | null;
  readonly meanDelaySeconds: number | null;
  readonly medianDelaySeconds: number | null;
  readonly delayedStops: number;
  readonly coverage: number | null;
}

export type HistoryHeatmapType =
  | "hour-weekday"
  | "station-hour"
  | "station-weekday"
  | "line-hour"
  | "line-weekday"
  | "segment-hour"
  | "segment-weekday";

export type HistoryHeatmapMetric =
  | "punctuality"
  | "mean-delay"
  | "median-delay"
  | "cancellation-rate"
  | "coverage"
  | "added-delay";

export type HistoryHeatmapDimension = "hour" | "weekday" | "station" | "line" | "segment";

export interface HistoryHeatmapRequest {
  readonly context: HistoryAnalysisContext;
  readonly filters: HistoryFilters;
  readonly type: HistoryHeatmapType;
  /** Optional refinement when the page itself is network-scoped. */
  readonly lineSlug: string | null;
  /** Optional heatmap-local refinement. Global page filters remain authoritative. */
  readonly direction: DirectionId | null;
}

export interface HistoryHeatmapCell {
  readonly x: string;
  readonly xLabel: string;
  readonly xOrder: number;
  readonly y: string;
  readonly yLabel: string;
  readonly yOrder: number;
  readonly scheduled: number;
  readonly observed: number;
  readonly punctuality: number | null;
  readonly meanDelaySeconds: number | null;
  readonly medianDelaySeconds: number | null;
  readonly cancellationRate: number | null;
  readonly coverage: number | null;
  readonly addedDelaySeconds: number | null;
}

export interface HistoryHeatmapResponse {
  readonly type: HistoryHeatmapType;
  readonly xDimension: HistoryHeatmapDimension;
  readonly yDimension: HistoryHeatmapDimension;
  readonly lineSlug: string | null;
  readonly direction: DirectionId | null;
  readonly cells: readonly HistoryHeatmapCell[];
}

export const HISTORY_HEATMAP_TYPES: readonly HistoryHeatmapType[] = [
  "hour-weekday",
  "station-hour",
  "station-weekday",
  "line-hour",
  "line-weekday",
  "segment-hour",
  "segment-weekday",
];

export function historyHeatmapTypeRequiresLine(type: HistoryHeatmapType): boolean {
  return type === "station-hour" || type === "station-weekday" || type === "segment-hour" || type === "segment-weekday";
}

export function historyHeatmapTypeUsesSegments(type: HistoryHeatmapType): boolean {
  return type === "segment-hour" || type === "segment-weekday";
}

export function historyHeatmapTypesForContext(kind: HistoryAnalysisContextKind): readonly HistoryHeatmapType[] {
  if (kind === "line") return ["hour-weekday", "station-hour", "station-weekday", "segment-hour", "segment-weekday"];
  if (kind === "station") return ["hour-weekday", "line-hour", "line-weekday"];
  return HISTORY_HEATMAP_TYPES;
}
