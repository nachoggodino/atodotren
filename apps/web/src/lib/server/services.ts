import "server-only";

import type { HistoryFilters, HistoryResponse, MatrixResponse, ResponseMeta } from "@/lib/domain/contracts";
import { CATALOG_CACHE_SECONDS, CURRENT_HISTORY_CACHE_SECONDS, FINAL_HISTORY_CACHE_SECONDS } from "@/lib/design/tokens";
import { boundedDateRange } from "@/lib/domain/filters";
import { getDataAdapter } from "./adapter";
import { withTtlCache } from "./cache";

const LIVE_TTL = 30;

function scenarioKey(scenario: string | undefined): string { return scenario ?? "default"; }
function madridDate(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function historyTtl(filters: HistoryFilters): number { return filters.to < madridDate() ? FINAL_HISTORY_CACHE_SECONDS : CURRENT_HISTORY_CACHE_SECONDS; }
function normalizeHistoricalMeta<T extends { readonly meta: ResponseMeta }>(value: T): T {
  if (value.meta.sourceAt !== null || value.meta.status !== "outage") return value;
  return { ...value, meta: { ...value.meta, status: "live", stale: false } };
}

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
  return withTtlCache(`history:network:${scenarioKey(scenario)}:${JSON.stringify(safe)}`, historyTtl(safe), async () => normalizeHistoricalMeta(await adapter.historyNetwork(safe)));
}

export async function getHistoryLine(slug: string, filters: HistoryFilters, scenario?: string): Promise<HistoryResponse | null> {
  const safe = boundedDateRange(filters);
  const adapter = await getDataAdapter(scenario);
  return withTtlCache(`history:line:${slug}:${scenarioKey(scenario)}:${JSON.stringify(safe)}`, historyTtl(safe), async () => {
    const value = await adapter.historyLine(slug, safe);
    return value === null ? null : normalizeHistoricalMeta(value);
  });
}

export async function getHistoryStation(slug: string, filters: HistoryFilters, scenario?: string): Promise<HistoryResponse | null> {
  const safe = boundedDateRange(filters);
  const adapter = await getDataAdapter(scenario);
  return withTtlCache(`history:station:${slug}:${scenarioKey(scenario)}:${JSON.stringify(safe)}`, historyTtl(safe), async () => {
    const value = await adapter.historyStation(slug, safe);
    return value === null ? null : normalizeHistoricalMeta(value);
  });
}

export async function getMatrix(lineSlug: string, serviceDate: string, scenario?: string): Promise<MatrixResponse | null> {
  const adapter = await getDataAdapter(scenario);
  const ttl = serviceDate < madridDate() ? FINAL_HISTORY_CACHE_SECONDS : CURRENT_HISTORY_CACHE_SECONDS;
  return withTtlCache(`matrix:${lineSlug}:${serviceDate}:${scenarioKey(scenario)}`, ttl, async () => {
    const value = await adapter.matrix(lineSlug, serviceDate);
    return value === null ? null : normalizeHistoricalMeta(value);
  });
}
