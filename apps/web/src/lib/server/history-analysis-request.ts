import type { DirectionId } from "@/lib/domain/contracts";
import { parseHistoryFilters } from "@/lib/domain/filters";
import type { HistoryAnalysisContextKind, HistoryHeatmapRequest, HistoryHeatmapType } from "@/lib/domain/history-analysis";
import { HISTORY_HEATMAP_TYPES } from "@/lib/domain/history-analysis";

function contextKind(value: string | null): HistoryAnalysisContextKind {
  if (value === "network" || value === "line" || value === "station") return value;
  throw new Error("Invalid heatmap context");
}

function heatmapType(value: string | null): HistoryHeatmapType {
  if (value !== null && HISTORY_HEATMAP_TYPES.includes(value as HistoryHeatmapType)) return value as HistoryHeatmapType;
  throw new Error("Invalid heatmap type");
}

function direction(value: string | null): DirectionId | null {
  if (value === null || value === "") return null;
  if (value === "0") return 0;
  if (value === "1") return 1;
  throw new Error("Invalid heatmap direction");
}

export function historyHeatmapRequestFromRequest(request: Request): HistoryHeatmapRequest {
  const params = new URL(request.url).searchParams;
  const key = params.get("contextKey")?.trim() ?? "";
  if (key === "") throw new Error("Missing heatmap context key");
  return {
    context: { kind: contextKind(params.get("context")), key },
    filters: parseHistoryFilters(params),
    type: heatmapType(params.get("type")),
    lineSlug: params.get("line")?.trim().toLowerCase() || null,
    direction: direction(params.get("heatmapDirection")),
  };
}
