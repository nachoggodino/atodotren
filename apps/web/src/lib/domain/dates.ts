import { MADRID_NETWORK } from "./network";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function currentMadridDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MADRID_NETWORK.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function madridHour(now: Date = new Date()): number {
  const value = new Intl.DateTimeFormat("en-GB", {
    timeZone: MADRID_NETWORK.timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return Number(value);
}

export function offsetCalendarDate(value: string, days: number): string {
  if (!isCalendarDate(value)) throw new Error(`Invalid calendar date: ${value}`);
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function madridDateOffset(days: number, now: Date = new Date()): string {
  return offsetCalendarDate(currentMadridDate(now), days);
}

export function calendarDaysInclusive(from: string, to: string): number {
  if (!isCalendarDate(from) || !isCalendarDate(to)) return Number.NaN;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((end - start) / DAY_MS) + 1;
}

export function calendarDayOfWeek(value: string): number {
  if (!isCalendarDate(value)) throw new Error(`Invalid calendar date: ${value}`);
  return new Date(`${value}T12:00:00Z`).getUTCDay();
}
