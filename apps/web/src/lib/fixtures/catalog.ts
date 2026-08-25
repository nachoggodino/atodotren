import type { LineRef, StationRef } from "@/lib/domain/contracts";
import { fallbackLineColor } from "@/lib/domain/network";

export const fixtureLines: readonly LineRef[] = ["c1", "c2", "c3", "c4", "c5", "c7", "c8", "c10"].map((slug) => ({
  id: `line-${slug}`,
  slug,
  code: slug.toUpperCase(),
  name: { es: slug.toUpperCase(), en: slug.toUpperCase() },
  color: fallbackLineColor(slug),
}));

export const fixtureStations: readonly StationRef[] = [
  ["chamartin", "chamartin-clara-campoamor", "chamartin-clara-campoamor", "Chamartín Clara Campoamor", "Chamartín Clara Campoamor"],
  ["nuevos-ministerios", "nuevos-ministerios", "nuevos-ministerios", "Nuevos Ministerios", "Nuevos Ministerios"],
  ["recoletos", "recoletos", "recoletos", "Recoletos", "Recoletos"],
  ["atocha", "atocha", "atocha", "Atocha", "Atocha"],
  ["mendez-alvaro", "mendez-alvaro", "mendez-alvaro", "Méndez Álvaro", "Méndez Álvaro"],
  ["villaverde-bajo", "villaverde-bajo", "villaverde-bajo", "Villaverde Bajo", "Villaverde Bajo"],
  ["aeropuerto-t4", "aeropuerto-t4", "airport-t4", "Aeropuerto T4", "Airport T4"],
  ["aeropuerto-t123", "aeropuerto-t1-t2-t3", "airport-t1-t2-t3", "Aeropuerto T1-T2-T3", "Airport T1-T2-T3"],
  ["san-fernando-largo", "san-fernando-de-henares-estacion-central", "san-fernando-de-henares-central-station", "San Fernando de Henares Estación Central", "San Fernando de Henares Central Station"],
].map(([id, slugEs, slugEn, nameEs, nameEn]) => ({ id, slug: { es: slugEs, en: slugEn }, name: { es: nameEs, en: nameEn } }));

export const fixtureStationAliases: Readonly<Record<string, readonly string[]>> = {
  atocha: ["madrid puerta de atocha", "atocha cercanias", "atocha cercanías"],
  chamartin: ["chamartin", "chamartín", "madrid chamartin"],
  "nuevos-ministerios": ["nuevos", "ministerios"],
  "aeropuerto-t4": ["aeropuerto", "airport", "t4"],
  "aeropuerto-t123": ["aeropuerto", "airport", "t1", "t2", "t3"],
};
