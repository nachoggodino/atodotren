import "server-only";

import type { HistoryFilters } from "@/lib/domain/contracts";
import { parseHistoryFilters } from "@/lib/domain/filters";

const CURRENT_HISTORY_CACHE_SECONDS = 300;
const FINAL_HISTORY_CACHE_SECONDS = 3_600;

export function madridDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function cacheSecondsForDate(date: string, now: Date = new Date()): number {
  return date < madridDate(now) ? FINAL_HISTORY_CACHE_SECONDS : CURRENT_HISTORY_CACHE_SECONDS;
}

export function historyFiltersFromRequest(request: Request): HistoryFilters {
  return parseHistoryFilters(new URL(request.url).searchParams);
}

export function cacheSecondsForHistory(filters: HistoryFilters, now: Date = new Date()): number {
  return cacheSecondsForDate(filters.to, now);
}
