import type { Lang } from "./contracts";
export { delayBand } from "./delay-policy";

export function formatDelay(seconds: number | null, lang: Lang): string {
  if (seconds === null) return "—";
  const sign = seconds < 0 ? "−" : seconds > 0 ? "+" : "";
  const absolute = Math.abs(seconds);
  const minutes = Math.floor(absolute / 60);
  const remainder = absolute % 60;
  if (minutes === 0) return `${sign}${remainder} s`;
  return `${sign}${minutes} min ${String(remainder).padStart(2, "0")} s`;
}

export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function formatMadridTime(value: string | null, lang: Lang, includeSeconds = false): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat(lang === "es" ? "es-ES" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
    timeZone: "Europe/Madrid",
  }).format(new Date(value));
}

export function formatHistoryDate(value: string, lang: Lang, includeYear: boolean): string {
  const date = new Date(`${value}T12:00:00Z`);
  return new Intl.DateTimeFormat(lang === "es" ? "es-ES" : "en-GB", {
    day: "2-digit",
    month: "short",
    ...(includeYear ? { year: "2-digit" } : {}),
    timeZone: "UTC",
  }).format(date);
}
