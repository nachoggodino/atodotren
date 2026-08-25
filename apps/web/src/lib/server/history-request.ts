import "server-only";

import type { HistoryFilters } from "@/lib/domain/contracts";
import { currentMadridDate } from "@/lib/domain/dates";
import { parseHistoryFilters } from "@/lib/domain/filters";

const CURRENT_DATE_CACHE_SECONDS = 300;
const PAST_DATE_CACHE_SECONDS = 3_600;

export function cacheSecondsForDate(date: string, now: Date = new Date()): number {
  return date < currentMadridDate(now) ? PAST_DATE_CACHE_SECONDS : CURRENT_DATE_CACHE_SECONDS;
}

export function historyFiltersFromRequest(request: Request): HistoryFilters {
  return parseHistoryFilters(new URL(request.url).searchParams);
}

export function cacheSecondsForHistory(filters: HistoryFilters, now: Date = new Date()): number {
  return cacheSecondsForDate(filters.to, now);
}
