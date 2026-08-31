import "server-only";

import type { HistoryFilters, HistoryResponse, MatrixResult } from "@/lib/domain/contracts";
import { boundedDateRange } from "@/lib/domain/filters";
import type { HistoryAnalysisContext, HistoryHeatmapRequest, HistoryHeatmapResponse, HistoryTrendPoint } from "@/lib/domain/history-analysis";
import { LIVE_CACHE_SECONDS } from "@/lib/domain/live-policy";
import { fixtureHistoryHeatmap, fixtureHistoryTrend, fixtureLineDirections } from "@/lib/fixtures/history-analysis";
import { effectiveFixtureScenario, getDataAdapter } from "./adapter";
import { cacheKey, getCached } from "./cache";
import { cacheSecondsForDate, cacheSecondsForHistory } from "./history-request";

export { LIVE_CACHE_SECONDS } from "@/lib/domain/live-policy";
export const CATALOG_CACHE_SECONDS = 86_400;

function scenarioKey(scenario: string | undefined): string {
  return effectiveFixtureScenario(scenario) ?? "production";
}

export async function searchCatalog(query: string, scenario?: string) {
  const normalized = query.trim().slice(0, 100);
  if (normalized === "") return [];
  const adapter = await getDataAdapter(scenario);
  return getCached(cacheKey(["search", scenarioKey(scenario), normalized.toLowerCase()]), CATALOG_CACHE_SECONDS, () => adapter.search(normalized));
}

export async function getLandingOverview(scenario?: string) {
  const adapter = await getDataAdapter(scenario);
  return getCached(cacheKey(["landing", "overview", scenarioKey(scenario)]), LIVE_CACHE_SECONDS, () => adapter.landingOverview());
}

export async function getLiveNetwork(scenario?: string) {
  const adapter = await getDataAdapter(scenario);
  return getCached(cacheKey(["live", "network", scenarioKey(scenario)]), LIVE_CACHE_SECONDS, () => adapter.liveNetwork());
}

export async function getLiveLine(slug: string, scenario?: string) {
  const adapter = await getDataAdapter(scenario);
  return getCached(cacheKey(["live", "line", slug, scenarioKey(scenario)]), LIVE_CACHE_SECONDS, () => adapter.liveLine(slug));
}

export async function getLiveStation(slug: string, scenario?: string) {
  const adapter = await getDataAdapter(scenario);
  return getCached(cacheKey(["live", "station", slug, scenarioKey(scenario)]), LIVE_CACHE_SECONDS, () => adapter.liveStation(slug));
}

export async function getJourney(serviceDate: string, journeyId: string, scenario?: string) {
  const adapter = await getDataAdapter(scenario);
  return getCached(cacheKey(["journey", serviceDate, journeyId, scenarioKey(scenario)]), LIVE_CACHE_SECONDS, () => adapter.journey(serviceDate, journeyId));
}

export async function getHistoryNetwork(filters: HistoryFilters, scenario?: string): Promise<HistoryResponse> {
  const safe = boundedDateRange(filters);
  const adapter = await getDataAdapter(scenario);
  return getCached(cacheKey(["history", "network", scenarioKey(scenario), safe]), cacheSecondsForHistory(safe), () => adapter.historyNetwork(safe));
}

export async function getHistoryLine(slug: string, filters: HistoryFilters, scenario?: string): Promise<HistoryResponse | null> {
  const safe = boundedDateRange(filters);
  const adapter = await getDataAdapter(scenario);
  return getCached(cacheKey(["history", "line", slug, scenarioKey(scenario), safe]), cacheSecondsForHistory(safe), () => adapter.historyLine(slug, safe));
}

export async function getHistoryStation(slug: string, filters: HistoryFilters, scenario?: string): Promise<HistoryResponse | null> {
  const safe = boundedDateRange(filters);
  const adapter = await getDataAdapter(scenario);
  return getCached(cacheKey(["history", "station", slug, scenarioKey(scenario), safe]), cacheSecondsForHistory(safe), () => adapter.historyStation(slug, safe));
}

export async function getHistoryTrend(context: HistoryAnalysisContext, filters: HistoryFilters, scenario?: string): Promise<readonly HistoryTrendPoint[]> {
  const safe = boundedDateRange(filters);
  const adapter = await getDataAdapter(scenario);
  return getCached(cacheKey(["history-analysis", "trend", context, scenarioKey(scenario), safe]), cacheSecondsForHistory(safe), () =>
    adapter.historyTrend === undefined ? Promise.resolve(fixtureHistoryTrend(context, safe)) : adapter.historyTrend(context, safe));
}

export async function getHistoryHeatmap(request: HistoryHeatmapRequest, scenario?: string): Promise<HistoryHeatmapResponse> {
  const safeFilters = boundedDateRange(request.filters);
  const safeRequest: HistoryHeatmapRequest = { ...request, filters: safeFilters };
  const adapter = await getDataAdapter(scenario);
  return getCached(cacheKey(["history-analysis", "heatmap", scenarioKey(scenario), safeRequest]), cacheSecondsForHistory(safeFilters), () =>
    adapter.historyHeatmap === undefined ? Promise.resolve(fixtureHistoryHeatmap(safeRequest)) : adapter.historyHeatmap(safeRequest));
}

export async function getLineDirections(slug: string, scenario?: string) {
  const normalized = slug.trim().toLowerCase();
  const adapter = await getDataAdapter(scenario);
  return getCached(cacheKey(["history-analysis", "directions", normalized, scenarioKey(scenario)]), CATALOG_CACHE_SECONDS, () =>
    adapter.lineDirections === undefined ? Promise.resolve(fixtureLineDirections(normalized)) : adapter.lineDirections(normalized));
}

export async function getMatrix(lineSlug: string, serviceDate: string, scenario?: string): Promise<MatrixResult> {
  try {
    const adapter = await getDataAdapter(scenario);
    return await getCached(cacheKey(["matrix", lineSlug, serviceDate, scenarioKey(scenario)]), cacheSecondsForDate(serviceDate), () => adapter.matrix(lineSlug, serviceDate));
  } catch {
    return { status: "failed", reason: "temporarily-unavailable" };
  }
}
