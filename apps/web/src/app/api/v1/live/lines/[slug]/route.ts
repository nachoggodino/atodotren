import { apiError, apiJson, scenarioFromRequest, withApiErrorBoundary } from "@/lib/server/api";
import { LIVE_CACHE_SECONDS, getLiveLine } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { readonly params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!/^[a-z0-9-]{1,40}$/.test(slug)) return apiError("invalid-line-slug", "Invalid request", 400);
  return withApiErrorBoundary("live-line", async () => {
    const data = await getLiveLine(slug, scenarioFromRequest(request));
    return data === null ? apiError("line-not-found", "Resource not found", 404) : apiJson(data, LIVE_CACHE_SECONDS);
  });
}
