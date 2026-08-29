import type { LocalizedName } from "./contracts";

export const MADRID_LINE_TEXT_COLOR = "#ffffff" as const;

export const MADRID_LINES = [
  { slug: "c1", code: "C1", color: "#5aa1d8" },
  { slug: "c2", code: "C2", color: "#2f7f50" },
  { slug: "c3", code: "C3", color: "#8e63a9" },
  { slug: "c4", code: "C4", color: "#285d9b" },
  { slug: "c5", code: "C5", color: "#e0a52b" },
  { slug: "c7", code: "C7", color: "#d64e4b" },
  { slug: "c8", code: "C8", color: "#7c6d62" },
  { slug: "c10", code: "C10", color: "#8b6cae" },
] as const;

const MADRID_LINE_COLORS = Object.fromEntries(MADRID_LINES.map(({ slug, color }) => [slug, color])) as Readonly<Record<string, string>>;

export const MADRID_NETWORK = {
  slug: "madrid",
  name: { es: "Cercanías Madrid", en: "Madrid Cercanías" } satisfies LocalizedName,
  timeZone: "Europe/Madrid",
  fallbackLineColor: "#59646a",
  lineTextColor: MADRID_LINE_TEXT_COLOR,
  lines: MADRID_LINES,
  lineColors: MADRID_LINE_COLORS,
} as const;

export function fallbackLineColor(slug: string): string {
  return MADRID_NETWORK.lineColors[slug] ?? MADRID_NETWORK.fallbackLineColor;
}
