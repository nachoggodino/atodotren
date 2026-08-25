import type { LocalizedName } from "./contracts";

export const MADRID_NETWORK = {
  slug: "madrid",
  name: { es: "Cercanías Madrid", en: "Madrid Cercanías" } satisfies LocalizedName,
  timeZone: "Europe/Madrid",
  fallbackLineColor: "#59646a",
  lineColors: {
    c1: "#5aa1d8",
    c2: "#2f7f50",
    c3: "#8e63a9",
    c4: "#285d9b",
    c5: "#e0a52b",
    c7: "#d64e4b",
    c8: "#7c6d62",
    c10: "#8b6cae",
  } as Readonly<Record<string, string>>,
} as const;

export function fallbackLineColor(slug: string): string {
  return MADRID_NETWORK.lineColors[slug] ?? MADRID_NETWORK.fallbackLineColor;
}
