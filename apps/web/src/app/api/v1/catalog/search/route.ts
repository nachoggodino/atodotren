import type { SearchResponse } from "@/lib/domain/contracts";
import { referenceResponseMeta } from "@/lib/domain/data-policy";
import { apiError, apiJson, scenarioFromRequest, withApiErrorBoundary } from "@/lib/server/api";
import { CATALOG_CACHE_SECONDS, searchCatalog } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (query.length > 100) return apiError("search-query-too-long", "Invalid request", 400);
  return withApiErrorBoundary("catalog-search", async () => {
    const results = await searchCatalog(query, scenarioFromRequest(request));
    const payload: SearchResponse = { meta: referenceResponseMeta("catalog-v1"), query, results };
    return apiJson(payload, CATALOG_CACHE_SECONDS);
  });
}
