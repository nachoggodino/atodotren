import type { EvidenceState, HistoryFilters, HistoryPoint, HistoryResponse, LinePerformance, LineRef, MatrixCell, MatrixJourney, MatrixResponse, ResponseMeta, SearchResult, StationRef, SummaryStats, TrainDetail } from "@/lib/domain/contracts";
import { FALLBACK_LINE_COLORS } from "@/lib/design/tokens";
import { normalizeSearch, normalizedLineAlias, SEARCH_RESULT_LIMIT } from "@/lib/domain/search";
import type { PublicDataAdapter } from "@/lib/server/data-adapter";

export type FixtureScenario = "healthy" | "partial" | "stale" | "outage" | "overnight" | "cancellations" | "missing" | "incomplete" | "finalized" | "ambiguous-search" | "empty-search" | "offline-cached";

const NOW = "2026-08-24T20:00:00.000Z";
const TODAY = "2026-08-24";

const lines: readonly LineRef[] = [
  { id: "line-c1", slug: "c1", code: "C1", name: { es: "C1", en: "C1" }, color: FALLBACK_LINE_COLORS.c1 ?? "#5aa1d8" },
  { id: "line-c2", slug: "c2", code: "C2", name: { es: "C2", en: "C2" }, color: FALLBACK_LINE_COLORS.c2 ?? "#2f7f50" },
  { id: "line-c3", slug: "c3", code: "C3", name: { es: "C3", en: "C3" }, color: FALLBACK_LINE_COLORS.c3 ?? "#8e63a9" },
  { id: "line-c4", slug: "c4", code: "C4", name: { es: "C4", en: "C4" }, color: FALLBACK_LINE_COLORS.c4 ?? "#285d9b" },
  { id: "line-c5", slug: "c5", code: "C5", name: { es: "C5", en: "C5" }, color: FALLBACK_LINE_COLORS.c5 ?? "#e0a52b" },
  { id: "line-c7", slug: "c7", code: "C7", name: { es: "C7", en: "C7" }, color: FALLBACK_LINE_COLORS.c7 ?? "#d64e4b" },
  { id: "line-c8", slug: "c8", code: "C8", name: { es: "C8", en: "C8" }, color: FALLBACK_LINE_COLORS.c8 ?? "#7c6d62" },
  { id: "line-c10", slug: "c10", code: "C10", name: { es: "C10", en: "C10" }, color: FALLBACK_LINE_COLORS.c10 ?? "#8b6cae" },
];

const stations: readonly StationRef[] = [
  { id: "chamartin", slug: { es: "chamartin-clara-campoamor", en: "chamartin-clara-campoamor" }, name: { es: "Chamartín Clara Campoamor", en: "Chamartín Clara Campoamor" } },
  { id: "nuevos-ministerios", slug: { es: "nuevos-ministerios", en: "nuevos-ministerios" }, name: { es: "Nuevos Ministerios", en: "Nuevos Ministerios" } },
  { id: "recoletos", slug: { es: "recoletos", en: "recoletos" }, name: { es: "Recoletos", en: "Recoletos" } },
  { id: "atocha", slug: { es: "atocha", en: "atocha" }, name: { es: "Atocha", en: "Atocha" } },
  { id: "mendez-alvaro", slug: { es: "mendez-alvaro", en: "mendez-alvaro" }, name: { es: "Méndez Álvaro", en: "Méndez Álvaro" } },
  { id: "villaverde-bajo", slug: { es: "villaverde-bajo", en: "villaverde-bajo" }, name: { es: "Villaverde Bajo", en: "Villaverde Bajo" } },
  { id: "aeropuerto-t4", slug: { es: "aeropuerto-t4", en: "airport-t4" }, name: { es: "Aeropuerto T4", en: "Airport T4" } },
  { id: "aeropuerto-t123", slug: { es: "aeropuerto-t1-t2-t3", en: "airport-t1-t2-t3" }, name: { es: "Aeropuerto T1-T2-T3", en: "Airport T1-T2-T3" } },
];

const stationAliases: Readonly<Record<string, readonly string[]>> = {
  atocha: ["madrid puerta de atocha", "atocha cercanias", "atocha cercanías"],
  chamartin: ["chamartin", "chamartín", "madrid chamartin"],
  "nuevos-ministerios": ["nuevos", "ministerios"],
  "aeropuerto-t4": ["aeropuerto", "airport", "t4"],
  "aeropuerto-t123": ["aeropuerto", "airport", "t1", "t2", "t3"],
};

const baseStats: SummaryStats = { scheduled: 2840, observed: 2576, punctuality: 0.731, meanDelaySeconds: 226, medianDelaySeconds: 150, canceled: 31, missing: 233, distribution: [162, 1721, 391, 184, 75, 43] };

function scenarioMeta(scenario: FixtureScenario, finalized = false): ResponseMeta {
  const partial = scenario === "partial";
  const status = scenario === "stale" ? "stale" : scenario === "outage" ? "outage" : scenario === "overnight" ? "overnight" : scenario === "offline-cached" ? "cached" : "live";
  const scheduled = baseStats.scheduled;
  const observed = scenario === "outage" ? 0 : partial ? 1390 : baseStats.observed;
  return {
    generatedAt: NOW,
    sourceAt: scenario === "outage" ? null : scenario === "stale" ? "2026-08-24T19:54:00.000Z" : "2026-08-24T19:59:42.000Z",
    status,
    stale: scenario === "stale" || scenario === "outage",
    coverage: { scheduled, observed, ratio: scheduled === 0 ? null : observed / scheduled },
    finalized: scenario === "finalized" ? true : finalized,
    algorithmVersion: "fixture-alpha-v1",
    precision: status === "overnight" ? "reported" : "mixed",
    exact: false,
    cache: scenario === "offline-cached" ? "offline" : "origin",
    serviceDate: TODAY,
  };
}

function lineStats(index: number, scenario: FixtureScenario): SummaryStats {
  const scheduled = 260 + index * 31;
  const missingBoost = scenario === "missing" ? 70 : 0;
  const observed = Math.max(0, scheduled - 18 - index * 2 - missingBoost);
  const canceled = scenario === "cancellations" ? 22 + index : 2 + (index % 4);
  return { scheduled, observed, punctuality: Math.max(0.48, 0.84 - index * 0.035), meanDelaySeconds: 118 + index * 32, medianDelaySeconds: 90 + index * 30, canceled, missing: scheduled - observed, distribution: [12, Math.round(observed * .65), Math.round(observed * .17), Math.round(observed * .09), Math.round(observed * .05), Math.round(observed * .04)] };
}

function performance(scenario: FixtureScenario): readonly LinePerformance[] {
  return lines.map((line, index) => ({ ...line, stats: lineStats(index, scenario), activeTrains: scenario === "overnight" || scenario === "outage" ? 0 : Math.max(1, 12 - index) }));
}

function c1Stops(): readonly { station: StationRef; order: number }[] {
  return stations.slice(0, 6).map((station, index) => ({ station, order: index }));
}

function train(id: string, stopIndex: number, delaySeconds: number | null, state: EvidenceState, inferred: boolean): TrainDetail {
  const line = lines[0]!;
  const stop = stations[stopIndex] ?? stations[0]!;
  const next = stations[stopIndex + 1] ?? null;
  const scheduled = new Date(Date.parse(NOW) + (stopIndex + 1) * 180_000).toISOString();
  return {
    id,
    journeyId: `journey-${id}`,
    serviceDate: TODAY,
    line,
    destination: stations[5] ?? null,
    position: inferred && next !== null ? { kind: "between_stations", stationId: null, fromStationId: stop.id, toStationId: next.id, progress: .48, basis: "feed-inferred", confidence: "medium" } : { kind: "at_station", stationId: stop.id, fromStationId: null, toStationId: null, progress: null, basis: "reported-stop", confidence: "high" },
    scheduledArrivalAt: scheduled,
    probableArrivalAt: delaySeconds === null ? null : new Date(Date.parse(scheduled) + delaySeconds * 1000).toISOString(),
    renfeReportedArrivalAt: state === "reported_only" && delaySeconds !== null ? new Date(Date.parse(scheduled) + delaySeconds * 1000).toISOString() : null,
    observedPresenceAt: state === "observed_presence" ? NOW : null,
    delaySeconds,
    state,
    sourceAt: "2026-08-24T19:59:42.000Z",
  };
}

function trains(scenario: FixtureScenario): readonly TrainDetail[] {
  if (scenario === "overnight" || scenario === "outage") return [];
  const states: readonly EvidenceState[] = scenario === "cancellations" ? ["observed_presence", "canceled", "reported_only", "observed_presence", "reported_only"] : scenario === "missing" ? ["observed_presence", "missing_evidence", "missing_evidence", "reported_only", "pending"] : ["observed_presence", "reported_only", "reported_only", "observed_presence", "pending"];
  return [train("C1-201", 0, 54, states[0]!, false), train("C1-207", 1, 186, states[1]!, true), train("C1-211", 2, 392, states[2]!, true), train("C1-215", 3, 742, states[3]!, false), train("C1-219", 4, null, states[4]!, true)];
}

function historyPoints(filters: HistoryFilters, seed: number): readonly HistoryPoint[] {
  const start = new Date(`${filters.from}T00:00:00Z`);
  const end = new Date(`${filters.to}T00:00:00Z`);
  const points: HistoryPoint[] = [];
  for (let cursor = new Date(start); cursor <= end && points.length < 366; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    if (filters.weekdays.length > 0 && !filters.weekdays.includes(cursor.getUTCDay())) continue;
    const index = points.length;
    const scheduled = 240 + ((index + seed) % 7) * 17;
    const observed = Math.round(scheduled * (.86 + ((index + seed) % 5) * .018));
    points.push({ date: cursor.toISOString().slice(0, 10), scheduled, observed, punctuality: .66 + ((index + seed) % 6) * .035, meanDelaySeconds: 155 + ((index * 47 + seed * 13) % 190), coverage: observed / scheduled });
  }
  return points;
}

function historyResponse(filters: HistoryFilters, kind: "network" | "line" | "station", label: string, id: string, seed: number, scenario: FixtureScenario): HistoryResponse {
  const trend = historyPoints(filters, seed);
  const scheduled = trend.reduce((sum, point) => sum + point.scheduled, 0);
  const observed = trend.reduce((sum, point) => sum + point.observed, 0);
  const weightedDelay = trend.reduce((sum, point) => sum + (point.meanDelaySeconds ?? 0) * point.observed, 0);
  const stats: SummaryStats = { scheduled, observed, punctuality: trend.length === 0 ? null : trend.reduce((sum, point) => sum + (point.punctuality ?? 0), 0) / trend.length, meanDelaySeconds: observed === 0 ? null : Math.round(weightedDelay / observed), medianDelaySeconds: observed === 0 ? null : 150 + seed * 12, canceled: Math.round(scheduled * .012), missing: scheduled - observed, distribution: [Math.round(observed * .06), Math.round(observed * .61), Math.round(observed * .17), Math.round(observed * .09), Math.round(observed * .045), Math.round(observed * .025)] };
  const rankings = performance(scenario).slice().sort((a, b) => (b.stats.meanDelaySeconds ?? 0) - (a.stats.meanDelaySeconds ?? 0)).slice(0, 5).map((line) => ({ id: line.id, label: line.code, sample: line.stats.observed, meanDelaySeconds: line.stats.meanDelaySeconds, punctuality: line.stats.punctuality }));
  return { meta: scenarioMeta(scenario, scenario === "finalized"), context: { kind, label, id }, filters, stats, trend, rankings };
}

function matrix(scenario: FixtureScenario): MatrixResponse {
  const matrixStations = stations.slice(0, 6);
  const journeys: MatrixJourney[] = Array.from({ length: 7 }, (_, index) => ({ id: `mx-${index + 1}`, label: `C1 ${String(700 + index * 13)}`, direction: index % 2 === 0 ? 0 : 1 }));
  const cells: MatrixCell[] = [];
  for (const [journeyIndex, journey] of journeys.entries()) for (const [stationIndex, station] of matrixStations.entries()) {
    const scheduled = new Date(Date.UTC(2026, 7, 24, 6, 10 + journeyIndex * 18 + stationIndex * 4)).toISOString();
    let state: EvidenceState = stationIndex + journeyIndex > 9 && scenario !== "finalized" ? "pending" : "reported_only";
    if (scenario === "cancellations" && journeyIndex === 3 && stationIndex >= 3) state = "canceled";
    if (scenario === "missing" && (journeyIndex + stationIndex) % 8 === 0) state = "missing_evidence";
    const delay = state === "canceled" || state === "missing_evidence" || state === "pending" ? null : ((journeyIndex * 97 + stationIndex * 61) % 820) - 45;
    cells.push({ journeyId: journey.id, stationId: station.id, scheduledAt: scheduled, reportedAt: delay === null ? null : new Date(Date.parse(scheduled) + delay * 1000).toISOString(), delaySeconds: delay, state });
  }
  return { meta: scenarioMeta(scenario, scenario === "finalized"), line: lines[0]!, date: TODAY, stations: matrixStations, journeys, cells };
}

function isScenario(value: string): value is FixtureScenario {
  return ["healthy", "partial", "stale", "outage", "overnight", "cancellations", "missing", "incomplete", "finalized", "ambiguous-search", "empty-search", "offline-cached"].includes(value);
}

export function createFixtureAdapter(rawScenario: string): PublicDataAdapter {
  const scenario: FixtureScenario = isScenario(rawScenario) ? rawScenario : "healthy";
  return {
    async search(query) {
      if (scenario === "empty-search") return [];
      const needle = normalizedLineAlias(query);
      const results: SearchResult[] = [];
      for (const line of lines) {
        const haystack = [line.code, line.slug, line.name.es, line.name.en].map(normalizedLineAlias);
        if (haystack.some((value) => value.includes(needle))) results.push({ kind: "line", id: line.id, slug: { es: line.slug, en: line.slug }, code: line.code, name: line.name });
      }
      for (const station of stations) {
        const aliases = stationAliases[station.id] ?? [];
        const haystack = [station.id, station.slug.es, station.slug.en, station.name.es, station.name.en, ...aliases].map(normalizeSearch);
        if (haystack.some((value) => value.includes(normalizeSearch(query)))) results.push({ kind: "station", id: station.id, slug: station.slug, code: null, name: station.name });
      }
      if (scenario === "ambiguous-search" && normalizeSearch(query).includes("aeropuerto")) return results.filter((result) => result.id.startsWith("aeropuerto"));
      return results.slice(0, SEARCH_RESULT_LIMIT);
    },
    async liveNetwork() { return { meta: scenarioMeta(scenario), stats: scenario === "outage" ? { ...baseStats, observed: 0, punctuality: null, meanDelaySeconds: null, medianDelaySeconds: null } : baseStats, lines: performance(scenario) }; },
    async liveLine(slug) {
      const line = lines.find((candidate) => normalizedLineAlias(candidate.slug) === normalizedLineAlias(slug));
      if (line === undefined) return null;
      const index = lines.indexOf(line);
      return { meta: scenarioMeta(scenario), context: line, stats: lineStats(index, scenario), comparison: { label: "same-weekday-hour", punctuality: .81 - index * .02, meanDelaySeconds: 146 + index * 18 }, stops: c1Stops(), trains: line.slug === "c1" ? trains(scenario) : [] };
    },
    async liveStation(slug) {
      const station = stations.find((candidate) => candidate.slug.es === slug || candidate.slug.en === slug || candidate.id === slug);
      if (station === undefined) return null;
      return { meta: scenarioMeta(scenario), context: station, stats: { ...baseStats, scheduled: 310, observed: scenario === "partial" ? 168 : 281, missing: scenario === "partial" ? 142 : 29 }, comparison: { label: "same-weekday-hour", punctuality: .79, meanDelaySeconds: 172 }, stops: [], trains: trains(scenario).filter((item) => item.position.stationId === station.id || item.position.fromStationId === station.id || item.position.toStationId === station.id) };
    },
    async journey(serviceDate, journeyId) { return trains(scenario).find((item) => item.serviceDate === serviceDate && (item.journeyId === journeyId || item.id === journeyId)) ?? null; },
    async historyNetwork(filters) { return historyResponse(filters, "network", "Cercanías Madrid", "madrid", 1, scenario); },
    async historyLine(slug, filters) { const line = lines.find((candidate) => candidate.slug === normalizedLineAlias(slug)); return line === undefined ? null : historyResponse(filters, "line", line.code, line.id, lines.indexOf(line) + 2, scenario); },
    async historyStation(slug, filters) { const station = stations.find((candidate) => candidate.slug.es === slug || candidate.slug.en === slug || candidate.id === slug); return station === undefined ? null : historyResponse(filters, "station", station.name.es, station.id, stations.indexOf(station) + 3, scenario); },
    async matrix(lineSlug, serviceDate) { return normalizedLineAlias(lineSlug) === "c1" && serviceDate === TODAY ? matrix(scenario) : null; },
  };
}
