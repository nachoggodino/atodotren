import "server-only";

import type { HistoryFilters, HistoryResponse, MatrixResponse } from "@/lib/domain/contracts";
import { boundedDateRange } from "@/lib/domain/filters";
import { getDataAdapter } from "./adapter";
import { withTtlCache } from "./cache";
import { cacheSecondsForDate, cacheSecondsForHistory } from "./history-request";

const LIVE_TTL = 30;
const CATALOG_CACHE_SECONDS = 86_400;

function scenarioKey(scenario: string | undefined): string { return scenario ?? "default"; }

export async function searchCatalog(query: string, scenario?: string) {
  const normalized = query.trim().slice(0, 100);
  if (normalized === "") return [];
  const adapter = await getDataAdapter(scenario);
  return withTtlCache(`search:${scenarioKey(scenario)}:${normalized.toLowerCase()}`, CATALOG_CACHE_SECONDS, () => adapter.search(normalized));
}

export async function getLiveNetwork(scenario?: string) {
  const adapter = await getDataAdapter(scenario);
  return withTtlCache(`live:network:${scenarioKey(scenario)}`, LIVE_TTL, () => adapter.liveNetwork());
}

export async function getLiveLine(slug: string, scenario?: string) {
  const adapter = await getDataAdapter(scenario);
  return withTtlCache(`live:line:${slug}:${scenarioKey(scenario)}`, LIVE_TTL, () => adapter.liveLine(slug));
}

export async function getLiveStation(slug: string, scenario?: string) {
  const adapter = await getDataAdapter(scenario);
  return withTtlCache(`live:station:${slug}:${scenarioKey(scenario)}`, LIVE_TTL, () => adapter.liveStation(slug));
}

export async function getJourney(serviceDate: string, journeyId: string, scenario?: string) {
  const adapter = await getDataAdapter(scenario);
  return withTtlCache(`journey:${serviceDate}:${journeyId}:${scenarioKey(scenario)}`, LIVE_TTL, () => adapter.journey(serviceDate, journeyId));
}

export async function getHistoryNetwork(filters: HistoryFilters, scenario?: string): Promise<HistoryResponse> {
  const safe = boundedDateRange(filters);
  const adapter = await getDataAdapter(scenario);
  return withTtlCache(`history:network:${scenarioKey(scenario)}:${JSON.stringify(safe)}`, cacheSecondsForHistory(safe), () => adapter.historyNetwork(safe));
}

export async function getHistoryLine(slug: string, filters: HistoryFilters, scenario?: string): Promise<HistoryResponse | null> {
  const safe = boundedDateRange(filters);
  const adapter = await getDataAdapter(scenario);
  return withTtlCache(`history:line:${slug}:${scenarioKey(scenario)}:${JSON.stringify(safe)}`, cacheSecondsForHistory(safe), () => adapter.historyLine(slug, safe));
}

export async function getHistoryStation(slug: string, filters: HistoryFilters, scenario?: string): Promise<HistoryResponse | null> {
  const safe = boundedDateRange(filters);
  const adapter = await getDataAdapter(scenario);
  return withTtlCache(`history:station:${slug}:${scenarioKey(scenario)}:${JSON.stringify(safe)}`, cacheSecondsForHistory(safe), () => adapter.historyStation(slug, safe));
}

export async function getMatrix(lineSlug: string, serviceDate: string, scenario?: string): Promise<MatrixResponse | null> {
  const adapter = await getDataAdapter(scenario);
  return withTtlCache(`matrix:${lineSlug}:${serviceDate}:${scenarioKey(scenario)}`, cacheSecondsForDate(serviceDate), () => adapter.matrix(lineSlug, serviceDate));
}
