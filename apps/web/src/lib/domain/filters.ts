import type { HistoryFilters } from "./contracts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function safeDate(value: string | null, fallback: string): string {
  return value !== null && ISO_DATE.test(value) ? value : fallback;
}

function dateOffset(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function parseHistoryFilters(params: URLSearchParams): HistoryFilters {
  const to = safeDate(params.get("to"), dateOffset(0));
  const from = safeDate(params.get("from"), dateOffset(-13));
  const hourRaw = params.get("hour");
  const hourNumber = hourRaw === null ? null : Number(hourRaw);
  const hour = Number.isInteger(hourNumber) && hourNumber !== null && hourNumber >= 0 && hourNumber <= 23 ? hourNumber : null;
  const directionRaw = params.get("direction");
  const direction = directionRaw === "0" ? 0 : directionRaw === "1" ? 1 : null;
  const weekdays = (params.get("weekdays") ?? "")
    .split(",")
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
  return { from, to, weekdays, hour, direction };
}

export function boundedDateRange(filters: HistoryFilters, maximumDays = 366): HistoryFilters {
  const from = new Date(`${filters.from}T00:00:00Z`);
  const to = new Date(`${filters.to}T00:00:00Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
    throw new Error("Invalid historical date range");
  }
  const days = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (days > maximumDays) throw new Error(`Historical range exceeds ${maximumDays} days`);
  return filters;
}
