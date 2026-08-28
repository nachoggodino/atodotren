import type { Lang } from "./contracts";
export { delayBand } from "./delay-policy";

function formatDelayWithMinuteUnit(seconds: number | null, lang: Lang, minuteUnit: string): string {
  if (seconds === null) return "—";
  const sign = seconds < 0 ? "−" : seconds > 0 ? "+" : "";
  const absolute = Math.abs(seconds);
  const minutes = Math.floor(absolute / 60);
  const remainder = absolute % 60;
  const locale = lang === "es" ? "es-ES" : "en-GB";
  const number = new Intl.NumberFormat(locale, { useGrouping: false });
  if (minutes === 0) return `${sign}${number.format(remainder)} s`;
  const secondsPart = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false }).format(remainder);
  return `${sign}${number.format(minutes)} ${minuteUnit} ${secondsPart} s`;
}

export function formatDelay(seconds: number | null, lang: Lang): string {
  return formatDelayWithMinuteUnit(seconds, lang, "min");
}

export function formatCompactDelay(seconds: number | null, lang: Lang): string {
  return formatDelayWithMinuteUnit(seconds, lang, "m");
}

export function formatDuration(seconds: number, lang: Lang): string {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const number = new Intl.NumberFormat(lang === "es" ? "es-ES" : "en-GB");
  if (hours === 0) return `${number.format(totalMinutes)} min`;
  if (minutes === 0) return `${number.format(hours)} h`;
  return `${number.format(hours)} h ${number.format(minutes)} min`;
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
