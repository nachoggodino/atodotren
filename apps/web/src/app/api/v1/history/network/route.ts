import { apiJson, scenarioFromRequest, withApiErrorBoundary } from "@/lib/server/api";
import { cacheSecondsForHistory, historyFiltersFromRequest } from "@/lib/server/history-request";
import { getHistoryNetwork } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiErrorBoundary("history-network", async () => {
    const filters = historyFiltersFromRequest(request);
    const data = await getHistoryNetwork(filters, scenarioFromRequest(request));
    return apiJson(data, cacheSecondsForHistory(filters));
  });
}
