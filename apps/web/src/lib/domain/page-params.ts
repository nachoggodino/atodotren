import type { HistoryFilters } from "./contracts";
import { ValidationError } from "./errors";
import { parseHistoryFilters } from "./filters";

export type PageSearchParams = Readonly<Record<string, string | string[] | undefined>>;
export type HistoryPageFilterResult = { readonly ok: true; readonly filters: HistoryFilters } | { readonly ok: false };

function toSearchParams(params: PageSearchParams): URLSearchParams {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") values.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) values.set(key, value[0]);
  }
  return values;
}

export function historyFiltersFromPage(params: PageSearchParams): HistoryFilters {
  return parseHistoryFilters(toSearchParams(params));
}

export function tryHistoryFiltersFromPage(params: PageSearchParams): HistoryPageFilterResult {
  try {
    return { ok: true, filters: historyFiltersFromPage(params) };
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false };
    throw error;
  }
}

export function historyFiltersToSearchParams(filters: HistoryFilters, scenario?: string): URLSearchParams {
  const params = new URLSearchParams({ from: filters.from, to: filters.to });
  if (filters.weekdays.length > 0) params.set("weekdays", filters.weekdays.join(","));
  if (filters.hour !== null) params.set("hour", String(filters.hour));
  if (filters.direction !== null) params.set("direction", String(filters.direction));
  if (scenario !== undefined && scenario !== "") params.set("scenario", scenario);
  return params;
}
