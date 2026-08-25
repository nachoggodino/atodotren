import type { DirectionDescriptor, LineRef, SchematicPattern, StationRef } from "@/lib/domain/contracts";
import { fallbackLineColor } from "@/lib/domain/network";
import type { LineCatalogRow, StationCatalogRow, TopologyRow } from "../row-parser";

export function lineFromCatalogRow(row: LineCatalogRow): LineRef {
  const rawColor = row.color?.replace(/^#/, "") ?? "";
  const color = /^[0-9a-f]{6}$/i.test(rawColor) ? `#${rawColor}` : fallbackLineColor(row.slug);
  return {
    id: `line-${row.slug}`,
    slug: row.slug,
    code: row.publicCode,
    name: { es: row.nameEs, en: row.nameEn },
    color,
  };
}

export function stationFromCatalogRow(row: StationCatalogRow): StationRef {
  return {
    id: row.id,
    slug: { es: row.slugEs, en: row.slugEn },
    name: { es: row.nameEs, en: row.nameEn },
  };
}

function directionDescriptor(id: 0 | 1, stops: readonly StationRef[]): DirectionDescriptor {
  return {
    id,
    headsign: null,
    from: stops[0] ?? null,
    to: stops.at(-1) ?? null,
  };
}

export function topologyFromRows(rows: readonly TopologyRow[]): readonly SchematicPattern[] {
  const grouped = new Map<string, TopologyRow[]>();
  for (const row of rows) {
    const values = grouped.get(row.patternId) ?? [];
    values.push(row);
    grouped.set(row.patternId, values);
  }
  return [...grouped.entries()].map(([patternId, patternRows]) => {
    const ordered = [...patternRows].sort((left, right) => left.stopOrder - right.stopOrder);
    const first = ordered[0]!;
    if (ordered.some((row) => row.direction !== first.direction || row.branchSlug !== first.branchSlug)) {
      throw new Error(`Inconsistent topology rows for pattern ${patternId}`);
    }
    const stops = ordered.map((row) => ({ station: stationFromCatalogRow(row), order: row.stopOrder }));
    const stations = stops.map((stop) => stop.station);
    return {
      id: patternId,
      branchSlug: first.branchSlug,
      direction: directionDescriptor(first.direction, stations),
      stops,
      destination: stations.at(-1) ?? null,
    };
  }).sort((left, right) => left.direction.id - right.direction.id || left.id.localeCompare(right.id));
}

export function directionFallbacks(): readonly DirectionDescriptor[] {
  return [
    { id: 0, headsign: null, from: null, to: null },
    { id: 1, headsign: null, from: null, to: null },
  ];
}
