import type { LocalizedName } from "./contracts";

export const MADRID_LINE_TEXT_COLOR = "#ffffff" as const;

export const MADRID_LINES = [
  { slug: "c1", code: "C1", color: "#5aa1d8", surfaceColor: "#4479a2" },
  { slug: "c2", code: "C2", color: "#2f7f50", surfaceColor: "#2f7f50" },
  { slug: "c3", code: "C3", color: "#8e63a9", surfaceColor: "#8e63a9" },
  { slug: "c4", code: "C4", color: "#285d9b", surfaceColor: "#285d9b" },
  { slug: "c5", code: "C5", color: "#e0a52b", surfaceColor: "#926b1c" },
  { slug: "c7", code: "C7", color: "#d64e4b", surfaceColor: "#c64845" },
  { slug: "c8", code: "C8", color: "#7c6d62", surfaceColor: "#7c6d62" },
  { slug: "c10", code: "C10", color: "#8b6cae", surfaceColor: "#8467a5" },
] as const;

const MADRID_LINE_COLORS = Object.fromEntries(MADRID_LINES.map(({ slug, color }) => [slug, color])) as Readonly<Record<string, string>>;
const MADRID_LINE_SURFACE_COLORS = Object.fromEntries(MADRID_LINES.map(({ slug, surfaceColor }) => [slug, surfaceColor])) as Readonly<Record<string, string>>;

export const MADRID_NETWORK = {
  slug: "madrid",
  name: { es: "Cercanías Madrid", en: "Madrid Cercanías" } satisfies LocalizedName,
  timeZone: "Europe/Madrid",
  fallbackLineColor: "#59646a",
  fallbackLineSurfaceColor: "#59646a",
  lineTextColor: MADRID_LINE_TEXT_COLOR,
  lines: MADRID_LINES,
  lineColors: MADRID_LINE_COLORS,
  lineSurfaceColors: MADRID_LINE_SURFACE_COLORS,
} as const;

export function fallbackLineColor(slug: string): string {
  return MADRID_NETWORK.lineColors[slug] ?? MADRID_NETWORK.fallbackLineColor;
}

export function lineSurfaceColor(slug: string): string {
  return MADRID_NETWORK.lineSurfaceColors[slug] ?? MADRID_NETWORK.fallbackLineSurfaceColor;
}
