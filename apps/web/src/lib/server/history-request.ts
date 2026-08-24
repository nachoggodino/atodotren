import type { HistoryFilters } from "@/lib/domain/contracts";
import { parseHistoryFilters } from "@/lib/domain/filters";

export function historyFiltersFromRequest(request: Request): HistoryFilters {
  return parseHistoryFilters(new URL(request.url).searchParams);
}

export function cacheSecondsForHistory(filters: HistoryFilters): number {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return filters.to < today ? 3_600 : 300;
}
