import { isCalendarDate } from "@/lib/domain/dates";
import { apiError, apiJson, scenarioFromRequest, withApiErrorBoundary } from "@/lib/server/api";
import { cacheSecondsForDate } from "@/lib/server/history-request";
import { getMatrix } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { readonly params: Promise<{ lineSlug: string }> }) {
  const { lineSlug } = await params;
  const date = new URL(request.url).searchParams.get("date") ?? "";
  if (!/^[a-z0-9-]{1,40}$/.test(lineSlug) || !isCalendarDate(date)) return apiError("invalid-matrix-query", "Invalid request", 400);
  return withApiErrorBoundary("history-matrix", async () => {
    const result = await getMatrix(lineSlug, date, scenarioFromRequest(request));
    if (result.status === "available") return apiJson(result.matrix, cacheSecondsForDate(result.matrix.date));
    if (result.status === "failed") return apiError(result.reason, "Detailed matrix is temporarily unavailable", 503);
    return apiError(`matrix-${result.reason}`, "Detailed matrix is unavailable", result.reason === "retention" ? 410 : 404);
  });
}
