import type { DirectionId, HistoryFilters } from "./contracts";
import { calendarDaysInclusive, isCalendarDate, madridDateOffset } from "./dates";
import { ValidationError } from "./errors";

export const MAX_HISTORY_RANGE_DAYS = 366;

function dateParam(value: string | null, fallback: string, field: string): string {
  if (value === null || value === "") return fallback;
  if (!isCalendarDate(value)) throw new ValidationError(`Invalid ${field} date`, `invalid-${field}-date`);
  return value;
}

function hourParam(value: string | null): number | null {
  if (value === null || value === "") return null;
  if (!/^\d{1,2}$/.test(value)) throw new ValidationError("Invalid hour filter", "invalid-hour");
  const hour = Number(value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new ValidationError("Invalid hour filter", "invalid-hour");
  return hour;
}

function directionParam(value: string | null): DirectionId | null {
  if (value === null || value === "") return null;
  if (value === "0") return 0;
  if (value === "1") return 1;
  throw new ValidationError("Invalid direction filter", "invalid-direction");
}

function weekdayParams(value: string | null): readonly number[] {
  if (value === null || value === "") return [];
  const raw = value.split(",");
  if (raw.some((item) => !/^[0-6]$/.test(item))) throw new ValidationError("Invalid weekday filter", "invalid-weekdays");
  return [...new Set(raw.map(Number))].sort((left, right) => left - right);
}

export function parseHistoryFilters(params: URLSearchParams, now: Date = new Date()): HistoryFilters {
  const to = dateParam(params.get("to"), madridDateOffset(0, now), "to");
  const from = dateParam(params.get("from"), madridDateOffset(-13, now), "from");
  return boundedDateRange({
    from,
    to,
    weekdays: weekdayParams(params.get("weekdays")),
    hour: hourParam(params.get("hour")),
    direction: directionParam(params.get("direction")),
  });
}

export function boundedDateRange(filters: HistoryFilters, maximumDays = MAX_HISTORY_RANGE_DAYS): HistoryFilters {
  if (!isCalendarDate(filters.from) || !isCalendarDate(filters.to)) throw new ValidationError("Invalid historical date range", "invalid-date-range");
  const days = calendarDaysInclusive(filters.from, filters.to);
  if (!Number.isFinite(days) || days < 1) throw new ValidationError("Invalid historical date range", "invalid-date-range");
  if (days > maximumDays) throw new ValidationError(`Historical range exceeds ${maximumDays} days`, "history-range-too-large");
  return filters;
}
