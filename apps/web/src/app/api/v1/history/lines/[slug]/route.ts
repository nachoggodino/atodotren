import { apiError, apiJson, scenarioFromRequest, withApiErrorBoundary } from "@/lib/server/api";
import { cacheSecondsForHistory, historyFiltersFromRequest } from "@/lib/server/history-request";
import { getHistoryLine } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { readonly params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!/^[a-z0-9-]{1,40}$/.test(slug)) return apiError("invalid-line-slug", "Invalid request", 400);
  return withApiErrorBoundary("history-line", async () => {
    const filters = historyFiltersFromRequest(request);
    const data = await getHistoryLine(slug, filters, scenarioFromRequest(request));
    if (data === null) return apiError("line-not-found", "Resource not found", 404);
    return apiJson(data, cacheSecondsForHistory(filters));
  });
}
