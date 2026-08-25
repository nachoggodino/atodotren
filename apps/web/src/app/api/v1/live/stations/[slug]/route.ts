import { apiError, apiJson, scenarioFromRequest, withApiErrorBoundary } from "@/lib/server/api";
import { LIVE_CACHE_SECONDS, getLiveStation } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { readonly params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return apiError("invalid-station-slug", "Invalid request", 400);
  return withApiErrorBoundary("live-station", async () => {
    const data = await getLiveStation(slug, scenarioFromRequest(request));
    return data === null ? apiError("station-not-found", "Resource not found", 404) : apiJson(data, LIVE_CACHE_SECONDS);
  });
}
