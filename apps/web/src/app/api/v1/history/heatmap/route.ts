import { apiJson, scenarioFromRequest, withApiErrorBoundary } from "@/lib/server/api";
import { historyHeatmapRequestFromRequest } from "@/lib/server/history-analysis-request";
import { cacheSecondsForHistory } from "@/lib/server/history-request";
import { getHistoryHeatmap } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiErrorBoundary("history-heatmap", async () => {
    const heatmapRequest = historyHeatmapRequestFromRequest(request);
    const data = await getHistoryHeatmap(heatmapRequest, scenarioFromRequest(request));
    return apiJson(data, cacheSecondsForHistory(heatmapRequest.filters));
  });
}
