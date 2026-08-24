import "server-only";

import type { HistoryFilters } from "@/lib/domain/contracts";
import { CATALOG_CACHE_SECONDS, CURRENT_HISTORY_CACHE_SECONDS, FINAL_HISTORY_CACHE_SECONDS } from "@/lib/design/tokens";
import { boundedDateRange } from "@/lib/domain/filters";
import { getDataAdapter } from "./adapter";
import { withTtlCache } from "./cache";

const LIVE_TTL = 30;

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

export async function getHistoryNetwork(filters: HistoryFilters, scenario?: string) {
  const safe = boundedDateRange(filters);
  const adapter = await getDataAdapter(scenario);
  const value = await adapter.historyNetwork(safe);
  return withTtlCache(`history:network:${scenarioKey(scenario)}:${JSON.stringify(safe)}`, value.meta.finalized ? FINAL_HISTORY_CACHE_SECONDS : CURRENT_HISTORY_CACHE_SECONDS, async () => value);
}

export async function getHistoryLine(slug: string, filters: HistoryFilters, scenario?: string) {
  const safe = boundedDateRange(filters);
  const adapter = await getDataAdapter(scenario);
  const value = await adapter.historyLine(slug, safe);
  return withTtlCache(`history:line:${slug}:${scenarioKey(scenario)}:${JSON.stringify(safe)}`, value?.meta.finalized ? FINAL_HISTORY_CACHE_SECONDS : CURRENT_HISTORY_CACHE_SECONDS, async () => value);
}

export async function getHistoryStation(slug: string, filters: HistoryFilters, scenario?: string) {
  const safe = boundedDateRange(filters);
  const adapter = await getDataAdapter(scenario);
  const value = await adapter.historyStation(slug, safe);
  return withTtlCache(`history:station:${slug}:${scenarioKey(scenario)}:${JSON.stringify(safe)}`, value?.meta.finalized ? FINAL_HISTORY_CACHE_SECONDS : CURRENT_HISTORY_CACHE_SECONDS, async () => value);
}

export async function getMatrix(lineSlug: string, serviceDate: string, scenario?: string) {
  const adapter = await getDataAdapter(scenario);
  return withTtlCache(`matrix:${lineSlug}:${serviceDate}:${scenarioKey(scenario)}`, CURRENT_HISTORY_CACHE_SECONDS, () => adapter.matrix(lineSlug, serviceDate));
}
