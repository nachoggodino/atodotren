import type { MatrixResult, SearchResult, TrainPosition } from "@/lib/domain/contracts";
import { MADRID_NETWORK } from "@/lib/domain/network";
import { normalizeSearch, normalizedLineAlias, SEARCH_RESULT_LIMIT } from "@/lib/domain/search";
import type { PublicDataAdapter } from "@/lib/server/data-adapter";
import { fixtureLines, fixtureStationAliases, fixtureStations } from "./catalog";
import { baseStats, c1Patterns, comparison, FIXTURE_TODAY, fixtureTrains, historyResponse, isFixtureScenario, linePerformance, lineStats, liveMeta, matrixResponse, type FixtureScenario } from "./builders";

function containsStation(position: TrainPosition, stationId: string): boolean {
  switch (position.kind) {
    case "at_station":
      return position.stationId === stationId;
    case "between_stations":
      return position.fromStationId === stationId || position.toStationId === stationId;
    case "unknown":
      return position.stationHintId === stationId;
  }
}

function failSource(scenario: FixtureScenario): void {
  if (scenario === "source-error") throw new Error("Deterministic fixture data-source failure");
}

export function createFixtureAdapter(rawScenario: string): PublicDataAdapter {
  const scenario: FixtureScenario = isFixtureScenario(rawScenario) ? rawScenario : "healthy";
  return {
    async search(query) {
      failSource(scenario);
      if (scenario === "empty-search") return [];
      const needle = normalizedLineAlias(query);
      const normalizedNeedle = normalizeSearch(query);
      const results: SearchResult[] = [];
      for (const line of fixtureLines) {
        const haystack = [line.code, line.slug, line.name.es, line.name.en].map(normalizedLineAlias);
        if (haystack.some((value) => value.includes(needle))) results.push({ kind: "line", id: line.id, slug: { es: line.slug, en: line.slug }, code: line.code, name: line.name });
      }
      for (const station of fixtureStations) {
        const aliases = fixtureStationAliases[station.id] ?? [];
        const haystack = [station.id, station.slug.es, station.slug.en, station.name.es, station.name.en, ...aliases].map(normalizeSearch);
        if (haystack.some((value) => value.includes(normalizedNeedle))) results.push({ kind: "station", id: station.id, slug: station.slug, code: null, name: station.name });
      }
      if (scenario === "ambiguous-search" && normalizedNeedle.includes("aeropuerto")) return results.filter((result) => result.id.startsWith("aeropuerto"));
      return results.slice(0, SEARCH_RESULT_LIMIT);
    },
    async liveNetwork() {
      failSource(scenario);
      const stats = scenario === "partial" ? { ...baseStats, observed: 1390, missing: 1450 } : scenario === "outage" ? { ...baseStats, observed: 0, punctuality: null, meanDelaySeconds: null, medianDelaySeconds: null, missing: baseStats.scheduled } : baseStats;
      const lines = linePerformance(scenario);
      const active = lines.reduce((sum, line) => sum + line.activeTrains, 0);
      return { meta: liveMeta(scenario, stats, active), stats, lines };
    },
    async liveLine(slug) {
      failSource(scenario);
      const line = fixtureLines.find((candidate) => normalizedLineAlias(candidate.slug) === normalizedLineAlias(slug));
      if (line === undefined) return null;
      const index = fixtureLines.indexOf(line);
      const trains = line.slug === "c1" ? fixtureTrains(scenario) : [];
      const stats = lineStats(index, scenario);
      return { meta: liveMeta(scenario, stats, trains.length), context: line, stats, comparison: comparison(scenario, index), patterns: line.slug === "c1" ? c1Patterns(scenario) : [], trains };
    },
    async liveStation(slug) {
      failSource(scenario);
      const station = fixtureStations.find((candidate) => candidate.slug.es === slug || candidate.slug.en === slug || candidate.id === slug);
      if (station === undefined) return null;
      const trains = fixtureTrains(scenario).filter((item) => containsStation(item.position, station.id));
      const stats = scenario === "partial" ? { ...baseStats, scheduled: 310, observed: 168, missing: 142 } : { ...baseStats, scheduled: 310, observed: 281, missing: 29 };
      return { meta: liveMeta(scenario, stats, trains.length), context: station, stats, comparison: comparison(scenario, 2), patterns: [], trains };
    },
    async journey(serviceDate, journeyId) {
      failSource(scenario);
      return fixtureTrains(scenario).find((item) => item.serviceDate === serviceDate && (item.journeyId === journeyId || item.id === journeyId)) ?? null;
    },
    async historyNetwork(filters) {
      failSource(scenario);
      return historyResponse(filters, "network", MADRID_NETWORK.name.es, MADRID_NETWORK.slug, 1, scenario);
    },
    async historyLine(slug, filters) {
      failSource(scenario);
      const line = fixtureLines.find((candidate) => candidate.slug === normalizedLineAlias(slug));
      return line === undefined ? null : historyResponse(filters, "line", line.code, line.id, fixtureLines.indexOf(line) + 2, scenario);
    },
    async historyStation(slug, filters) {
      failSource(scenario);
      const station = fixtureStations.find((candidate) => candidate.slug.es === slug || candidate.slug.en === slug || candidate.id === slug);
      return station === undefined ? null : historyResponse(filters, "station", station.name.es, station.id, fixtureStations.indexOf(station) + 3, scenario);
    },
    async matrix(lineSlug, serviceDate): Promise<MatrixResult> {
      failSource(scenario);
      if (normalizedLineAlias(lineSlug) !== "c1") return { status: "unavailable", reason: "no-data" };
      if (serviceDate !== FIXTURE_TODAY) return { status: "unavailable", reason: "retention" };
      return { status: "available", matrix: matrixResponse(scenario) };
    },
  };
}
