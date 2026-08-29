import type { LocalizedName } from "./contracts";

export const MADRID_LINES = [
  { slug: "c1", code: "C1", color: "#5aa1d8", textColor: "#ffffff" },
  { slug: "c2", code: "C2", color: "#2f7f50", textColor: "#ffffff" },
  { slug: "c3", code: "C3", color: "#8e63a9", textColor: "#ffffff" },
  { slug: "c4", code: "C4", color: "#285d9b", textColor: "#ffffff" },
  { slug: "c5", code: "C5", color: "#e0a52b", textColor: "#000000" },
  { slug: "c7", code: "C7", color: "#d64e4b", textColor: "#000000" },
  { slug: "c8", code: "C8", color: "#7c6d62", textColor: "#ffffff" },
  { slug: "c10", code: "C10", color: "#8b6cae", textColor: "#000000" },
] as const;

const MADRID_LINE_COLORS = Object.fromEntries(MADRID_LINES.map(({ slug, color }) => [slug, color])) as Readonly<Record<string, string>>;
const MADRID_LINE_TEXT_COLORS = Object.fromEntries(MADRID_LINES.map(({ slug, textColor }) => [slug, textColor])) as Readonly<Record<string, string>>;

export const MADRID_NETWORK = {
  slug: "madrid",
  name: { es: "Cercanías Madrid", en: "Madrid Cercanías" } satisfies LocalizedName,
  timeZone: "Europe/Madrid",
  fallbackLineColor: "#59646a",
  fallbackLineTextColor: "#ffffff",
  lines: MADRID_LINES,
  lineColors: MADRID_LINE_COLORS,
  lineTextColors: MADRID_LINE_TEXT_COLORS,
} as const;

export function fallbackLineColor(slug: string): string {
  return MADRID_NETWORK.lineColors[slug] ?? MADRID_NETWORK.fallbackLineColor;
}

export function preferredLineTextColor(slug: string): string {
  return MADRID_NETWORK.lineTextColors[slug] ?? MADRID_NETWORK.fallbackLineTextColor;
}
