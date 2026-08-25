import { apiError, apiJson, scenarioFromRequest } from "@/lib/server/api";
import { cacheSecondsForHistory, historyFiltersFromRequest } from "@/lib/server/history-request";
import { getHistoryLine } from "@/lib/server/services";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { readonly params: Promise<{ slug: string }> }) { const { slug } = await params; if (!/^[a-z0-9-]{1,40}$/.test(slug)) return apiError("Invalid line slug"); try { const filters = historyFiltersFromRequest(request); const data = await getHistoryLine(slug, filters, scenarioFromRequest(request)); return data === null ? apiError("Line not found", 404) : apiJson(data, cacheSecondsForHistory(filters)); } catch (error) { return apiError(error instanceof Error ? error.message : "Invalid historical query"); } }
