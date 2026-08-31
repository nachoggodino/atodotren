import { apiJson, scenarioFromRequest, withApiErrorBoundary } from "@/lib/server/api";
import { CATALOG_CACHE_SECONDS, getLineDirections } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { readonly params: Promise<{ slug: string }> }) {
  return withApiErrorBoundary("history-line-directions", async () => {
    const { slug } = await params;
    const directions = await getLineDirections(slug, scenarioFromRequest(request));
    return apiJson({ directions }, CATALOG_CACHE_SECONDS);
  });
}
