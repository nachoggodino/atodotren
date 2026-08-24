import { apiError, apiJson, scenarioFromRequest } from "@/lib/server/api";
import { searchCatalog } from "@/lib/server/services";
import { CATALOG_CACHE_SECONDS } from "@/lib/design/tokens";
import type { SearchResponse } from "@/lib/domain/contracts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (query.length > 100) return apiError("Search query is too long");
  const results = await searchCatalog(query, scenarioFromRequest(request));
  const payload: SearchResponse = { meta: { generatedAt: new Date().toISOString(), sourceAt: null, status: "live", stale: false, coverage: { scheduled: 0, observed: 0, ratio: null }, finalized: true, algorithmVersion: "catalog-v1", precision: "reported", exact: true, cache: "origin", serviceDate: null }, query, results };
  return apiJson(payload, CATALOG_CACHE_SECONDS);
}
