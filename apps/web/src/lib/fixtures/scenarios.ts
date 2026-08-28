import type { LandingOverviewResponse, MatrixResponse, MatrixResult, SearchResult, SummaryStats, TrainPosition } from "@/lib/domain/contracts";
import { MADRID_NETWORK } from "@/lib/domain/network";
import { normalizeSearch, normalizedLineAlias, SEARCH_RESULT_LIMIT } from "@/lib/domain/search";
import type { PublicDataAdapter } from "@/lib/server/data-adapter";
import { fixtureLines, fixtureStationAliases, fixtureStations } from "./catalog";
import { baseStats, c1Patterns, comparison, FIXTURE_NOW, FIXTURE_TODAY, fixtureTrains, historyResponse, isFixtureScenario, linePerformance, lineStats, liveMeta, matrixResponse, type FixtureScenario } from "./builders";

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

function networkStats(scenario: FixtureScenario): SummaryStats {
  if (scenario === "partial") return { ...baseStats, observed: 1390, missing: 1450 };
  if (scenario === "outage") return { ...baseStats, observed: 0, punctuality: null, meanDelaySeconds: null, medianDelaySeconds: null, p90DelaySeconds: null, missing: baseStats.scheduled };
  return baseStats;
}

function fixtureLandingOverview(scenario: FixtureScenario): LandingOverviewResponse {
  const stats = networkStats(scenario);
  const lines = linePerformance(scenario);
  const activeTrains = lines.reduce((sum, line) => sum + line.activeTrains, 0);
  const activeDelaySeconds = scenario === "outage" || scenario === "overnight" || scenario === "stale" ? 0 : activeTrains * 247;
  const completedJourneyContributions = scenario === "outage" ? 0 : 184 * 196;
  const dayDelaySeconds = completedJourneyContributions + activeDelaySeconds;
  const startsAt = Date.parse(`${FIXTURE_TODAY}T03:00:00.000Z`);
  const now = Date.parse(FIXTURE_NOW);
  const lastObservedIndex = Math.max(1, Math.min(42, Math.floor((now - startsAt) / (30 * 60_000))));
  const trend = Array.from({ length: 43 }, (_, index) => {
    const at = startsAt + index * 30 * 60_000;
    return {
      at: new Date(at).toISOString(),
      totalDelaySeconds: at > now ? null : Math.round(dayDelaySeconds * Math.pow(index / lastObservedIndex, 1.18)),
    };
  });
  return { meta: liveMeta(scenario, stats, activeTrains), activeTrains, activeDelaySeconds, dayDelaySeconds, trend };
}

function directionalFixtureMatrix(scenario: FixtureScenario): MatrixResponse {
  const matrix = matrixResponse(scenario);
  const reverseJourneys = new Set(matrix.journeys.filter((journey) => journey.direction?.id === 1).map((journey) => journey.id));
  if (reverseJourneys.size === 0) return matrix;
  const stationIndexes = new Map(matrix.stations.map((station, index) => [station.id, index]));
  const reversedStations = [...matrix.stations].reverse();
  return {
    ...matrix,
    cells: matrix.cells.map((cell) => {
      if (!reverseJourneys.has(cell.journeyId)) return cell;
      const stationIndex = stationIndexes.get(cell.stationId);
      const reverseStation = stationIndex === undefined ? undefined : reversedStations[stationIndex];
      return reverseStation === undefined ? cell : { ...cell, stationId: reverseStation.id };
    }),
  };
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
    async landingOverview() {
      failSource(scenario);
      return fixtureLandingOverview(scenario);
    },
    async liveNetwork() {
      failSource(scenario);
      const stats = networkStats(scenario);
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
      return historyResponse(filters, "network", MADRID_NETWORK.name.es, MADRID_NETWORK.slug, null, 1, scenario);
    },
    async historyLine(slug, filters) {
      failSource(scenario);
      const line = fixtureLines.find((candidate) => candidate.slug === normalizedLineAlias(slug));
      return line === undefined ? null : historyResponse(filters, "line", line.code, line.id, { es: line.slug, en: line.slug }, fixtureLines.indexOf(line) + 2, scenario);
    },
    async historyStation(slug, filters) {
      failSource(scenario);
      const station = fixtureStations.find((candidate) => candidate.slug.es === slug || candidate.slug.en === slug || candidate.id === slug);
      return station === undefined ? null : historyResponse(filters, "station", station.name.es, station.id, station.slug, fixtureStations.indexOf(station) + 3, scenario);
    },
    async matrix(lineSlug, serviceDate): Promise<MatrixResult> {
      failSource(scenario);
      if (scenario === "matrix-error") throw new Error("Deterministic matrix-only fixture failure");
      if (normalizedLineAlias(lineSlug) !== "c1") return { status: "unavailable", reason: "no-data" };
      if (serviceDate !== FIXTURE_TODAY) return { status: "unavailable", reason: "retention" };
      return { status: "available", matrix: directionalFixtureMatrix(scenario) };
    },
  };
}
