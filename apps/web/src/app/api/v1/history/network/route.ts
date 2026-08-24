import { apiError, apiJson, scenarioFromRequest } from "@/lib/server/api";
import { cacheSecondsForHistory, historyFiltersFromRequest } from "@/lib/server/history-request";
import { getHistoryNetwork } from "@/lib/server/services";

export const dynamic = "force-dynamic";
export async function GET(request: Request) { try { const filters = historyFiltersFromRequest(request); return apiJson(await getHistoryNetwork(filters, scenarioFromRequest(request)), cacheSecondsForHistory(filters)); } catch (error) { return apiError(error instanceof Error ? error.message : "Invalid historical query"); } }
