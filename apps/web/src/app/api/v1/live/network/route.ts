import { apiJson, scenarioFromRequest, withApiErrorBoundary } from "@/lib/server/api";
import { LIVE_CACHE_SECONDS, getLiveNetwork } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiErrorBoundary("live-network", async () => apiJson(await getLiveNetwork(scenarioFromRequest(request)), LIVE_CACHE_SECONDS));
}
