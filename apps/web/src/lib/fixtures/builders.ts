import type { Capability, Comparison, EvidenceState, HistoryFilters, HistoryPoint, HistoryResponse, HourWeekdayItem, LinePerformance, MatrixCell, MatrixJourney, MatrixResponse, RankingItem, ResponseMeta, SchematicPattern, SegmentDelayItem, SummaryStats, TrainDetail, TrainFieldEvidence, VolumeReliabilityItem } from "@/lib/domain/contracts";
import { historicalResponseMeta, liveResponseMeta } from "@/lib/domain/data-policy";
import { calendarDayOfWeek, offsetCalendarDate } from "@/lib/domain/dates";
import { distributionFromCounts } from "@/lib/domain/delay-policy";
import { MADRID_NETWORK } from "@/lib/domain/network";
import { fixtureLines, fixtureStations } from "./catalog";

export const FIXTURE_NOW = "2026-08-24T20:00:00.000Z";
export const FIXTURE_TODAY = "2026-08-24";

export type FixtureScenario =
  | "healthy"
  | "partial"
  | "stale"
  | "outage"
  | "overnight"
  | "cancellations"
  | "missing"
  | "incomplete"
  | "finalized"
  | "ambiguous-search"
  | "empty-search"
  | "offline-cached"
  | "mixed-versions"
  | "unsupported-capabilities"
  | "reverse-branch"
  | "zero-scheduled"
  | "zero-observed"
  | "large-history"
  | "large-matrix"
  | "matrix-error"
  | "source-error";

export const fixtureScenarios: readonly FixtureScenario[] = [
  "healthy", "partial", "stale", "outage", "overnight", "cancellations", "missing", "incomplete", "finalized",
  "ambiguous-search", "empty-search", "offline-cached", "mixed-versions", "unsupported-capabilities", "reverse-branch",
  "zero-scheduled", "zero-observed", "large-history", "large-matrix", "matrix-error", "source-error",
];

export function isFixtureScenario(value: string): value is FixtureScenario {
  return fixtureScenarios.includes(value as FixtureScenario);
}

export const baseStats: SummaryStats = {
  scheduled: 2840,
  observed: 2576,
  punctuality: 0.731,
  meanDelaySeconds: 226,
  medianDelaySeconds: 150,
  p90DelaySeconds: 525,
  canceled: 31,
  missing: 233,
  distribution: distributionFromCounts({ early: 162, punctual: 1721, "delay-2-5": 391, "delay-5-10": 184, "delay-10-15": 75, "delay-15-plus": 43 }),
};

function statsForScenario(stats: SummaryStats, scenario: FixtureScenario): SummaryStats {
  if (scenario === "zero-scheduled") return { ...stats, scheduled: 0, observed: 0, punctuality: null, meanDelaySeconds: null, medianDelaySeconds: null, p90DelaySeconds: null, canceled: 0, missing: 0, distribution: distributionFromCounts({}) };
  if (scenario === "zero-observed" || scenario === "outage") return { ...stats, observed: 0, punctuality: null, meanDelaySeconds: null, medianDelaySeconds: null, p90DelaySeconds: null, missing: stats.scheduled, distribution: distributionFromCounts({}) };
  if (scenario === "partial") return { ...stats, observed: Math.floor(stats.observed * 0.54), missing: Math.max(0, stats.scheduled - Math.floor(stats.observed * 0.54)) };
  return stats;
}

function fixtureProvenance(scenario: FixtureScenario): ResponseMeta["provenance"] {
  if (scenario === "mixed-versions") return { kind: "mixed", versions: ["fixture-alpha-v1", "fixture-alpha-v2"] };
  return { kind: "single", version: "fixture-alpha-v1" };
}

export function liveMeta(scenario: FixtureScenario, stats: SummaryStats, activeTrains: number): ResponseMeta {
  const sourceAt = scenario === "outage" ? null : scenario === "stale" ? "2026-08-24T19:54:00.000Z" : "2026-08-24T19:59:42.000Z";
  return liveResponseMeta({
    stats,
    sourceAt,
    activeTrains,
    serviceDate: FIXTURE_TODAY,
    finalization: scenario === "finalized" ? { state: "finalized", finalizedAt: "2026-08-25T02:10:00.000Z" } : { state: "processing", finalizedAt: null },
    provenance: fixtureProvenance(scenario),
    precision: scenario === "overnight" ? "reported" : "mixed",
    expectedOvernight: scenario === "overnight",
    cache: scenario === "offline-cached" ? "offline-cache" : "origin",
    now: new Date(FIXTURE_NOW),
  });
}

export function historyMeta(scenario: FixtureScenario, stats: SummaryStats, filters: HistoryFilters): ResponseMeta {
  const finalization = scenario === "finalized"
    ? { state: "finalized" as const, finalizedAt: "2026-08-25T02:10:00.000Z" }
    : filters.to === FIXTURE_TODAY
      ? { state: "processing" as const, finalizedAt: null }
      : { state: "unknown" as const, finalizedAt: null };
  return historicalResponseMeta({
    stats,
    serviceDate: filters.from === filters.to ? filters.to : null,
    finalization,
    provenance: fixtureProvenance(scenario),
    cache: scenario === "offline-cached" ? "offline-cache" : "origin",
    now: new Date(FIXTURE_NOW),
  });
}

export function lineStats(index: number, scenario: FixtureScenario): SummaryStats {
  const scheduled = 260 + index * 31;
  const missingBoost = scenario === "missing" ? 70 : 0;
  const observed = Math.max(0, scheduled - 18 - index * 2 - missingBoost);
  const canceled = scenario === "cancellations" ? 22 + index : 2 + (index % 4);
  return statsForScenario({
    scheduled,
    observed,
    punctuality: Math.max(0.48, 0.84 - index * 0.035),
    meanDelaySeconds: 118 + index * 32,
    medianDelaySeconds: 90 + index * 30,
    p90DelaySeconds: 330 + index * 45,
    canceled,
    missing: scheduled - observed,
    distribution: distributionFromCounts({ early: 12, punctual: Math.round(observed * 0.65), "delay-2-5": Math.round(observed * 0.17), "delay-5-10": Math.round(observed * 0.09), "delay-10-15": Math.round(observed * 0.05), "delay-15-plus": Math.round(observed * 0.04) }),
  }, scenario);
}

export function linePerformance(scenario: FixtureScenario): readonly LinePerformance[] {
  return fixtureLines.map((line, index) => ({
    ...line,
    stats: scenario === "unsupported-capabilities" ? { status: "unavailable", reason: "not-provided" } : { status: "available", value: lineStats(index, scenario) },
    activeTrains: scenario === "overnight" || scenario === "outage" ? 0 : Math.max(1, 12 - index),
  }));
}

function pattern(id: string, branchSlug: string, direction: 0 | 1, stationIndexes: readonly number[]): SchematicPattern {
  const selected = stationIndexes.map((index) => fixtureStations[index]!).filter(Boolean);
  return {
    id,
    branchSlug,
    direction: { id: direction, headsign: null, from: selected[0] ?? null, to: selected.at(-1) ?? null },
    stops: selected.map((station, index) => ({ station, order: index + 1 })),
    destination: selected.at(-1) ?? null,
  };
}

export function c1Patterns(scenario: FixtureScenario): readonly SchematicPattern[] {
  const forward = pattern("c1-main-0", "main", 0, [0, 1, 2, 3, 4, 5]);
  const reverse = pattern("c1-main-1", "main", 1, [5, 4, 3, 2, 1, 0]);
  const branch = pattern("c1-airport-0", "airport", 0, [0, 1, 2, 6, 7]);
  return scenario === "reverse-branch" ? [forward, reverse, branch] : [forward, reverse];
}

const reportedHigh: TrainFieldEvidence = { origin: "reported", confidence: "high" };
const inferredHigh: TrainFieldEvidence = { origin: "inferred", confidence: "high" };
const inferredMedium: TrainFieldEvidence = { origin: "inferred", confidence: "medium" };
const unavailable: TrainFieldEvidence = { origin: "unavailable", confidence: "unavailable" };

function train(input: {
  readonly id: string;
  readonly pattern: SchematicPattern | null;
  readonly position: TrainDetail["position"];
  readonly delaySeconds: number | null;
  readonly state: EvidenceState;
}): TrainDetail {
  const line = fixtureLines[0]!;
  const scheduled = "2026-08-24T20:03:00.000Z";
  const stationById = (id: string | null | undefined) => id === null || id === undefined ? null : fixtureStations.find((station) => station.id === id) ?? null;
  const currentStation = input.position.kind === "at_station" ? stationById(input.position.stationId) : null;
  const previousStation = input.position.kind === "between_stations" ? stationById(input.position.fromStationId) : null;
  const nextStation = input.position.kind === "between_stations" ? stationById(input.position.toStationId) : input.pattern?.destination ?? null;
  const probable = input.delaySeconds === null ? null : new Date(Date.parse(scheduled) + input.delaySeconds * 1000).toISOString();
  const reportedArrival = input.state === "reported_only" && input.delaySeconds !== null ? probable : null;
  return {
    id: input.id,
    journeyId: `journey-${input.id}`,
    serviceDate: FIXTURE_TODAY,
    line,
    patternId: input.pattern?.id ?? null,
    direction: input.pattern?.direction ?? null,
    headsign: input.pattern?.destination?.name ?? null,
    destination: input.pattern?.destination ?? null,
    currentStation,
    previousStation,
    nextStation,
    position: input.position,
    scheduledArrivalAt: scheduled,
    probableArrivalAt: probable,
    renfeReportedArrivalAt: reportedArrival,
    observedPresenceAt: input.state === "observed_presence" ? FIXTURE_NOW : null,
    observedPastArrivalAt: previousStation === null ? null : "2026-08-24T19:58:30.000Z",
    delaySeconds: input.delaySeconds,
    state: input.state,
    sourceAt: "2026-08-24T19:59:42.000Z",
    information: {
      servicePattern: input.pattern === null ? unavailable : inferredHigh,
      direction: input.pattern === null ? unavailable : inferredHigh,
      headsign: input.pattern?.destination === null || input.pattern?.destination === undefined ? unavailable : reportedHigh,
      destination: input.pattern?.destination === null || input.pattern?.destination === undefined ? unavailable : inferredHigh,
      currentStation: currentStation === null ? unavailable : reportedHigh,
      previousStation: previousStation === null ? unavailable : inferredMedium,
      nextStation: nextStation === null ? unavailable : inferredMedium,
      scheduledArrival: reportedHigh,
      probableArrival: probable === null ? unavailable : inferredMedium,
      reportedArrival: reportedArrival === null ? unavailable : reportedHigh,
      observedPresence: input.state === "observed_presence" || previousStation !== null ? reportedHigh : unavailable,
      delay: input.delaySeconds === null ? unavailable : reportedHigh,
    },
  };
}

export function fixtureTrains(scenario: FixtureScenario): readonly TrainDetail[] {
  if (scenario === "overnight" || scenario === "outage") return [];
  const [forward, reverse, branch] = c1Patterns("reverse-branch");
  const states: readonly EvidenceState[] = scenario === "cancellations"
    ? ["observed_presence", "canceled", "reported_only", "observed_presence", "reported_only"]
    : scenario === "missing"
      ? ["observed_presence", "missing_evidence", "missing_evidence", "reported_only", "pending"]
      : ["observed_presence", "reported_only", "reported_only", "observed_presence", "pending"];
  const values: TrainDetail[] = [
    train({ id: "C1-201", pattern: forward!, position: { kind: "at_station", stationId: fixtureStations[0]!.id, basis: "reported-stop", confidence: "high" }, delaySeconds: 54, state: states[0]! }),
    train({ id: "C1-207", pattern: forward!, position: { kind: "between_stations", fromStationId: fixtureStations[1]!.id, toStationId: fixtureStations[2]!.id, progress: null, basis: "feed-inferred", confidence: "medium" }, delaySeconds: 186, state: states[1]! }),
    train({ id: "C1-211", pattern: reverse!, position: { kind: "between_stations", fromStationId: fixtureStations[4]!.id, toStationId: fixtureStations[3]!.id, progress: null, basis: "schedule-inferred", confidence: "low" }, delaySeconds: 392, state: states[2]! }),
    train({ id: "C1-215", pattern: null, position: { kind: "unknown", stationHintId: fixtureStations[3]!.id, basis: "unavailable", confidence: "low" }, delaySeconds: 742, state: states[3]! }),
    train({ id: "C1-219", pattern: branch!, position: { kind: "at_station", stationId: fixtureStations[6]!.id, basis: "reported-stop", confidence: "high" }, delaySeconds: null, state: states[4]! }),
  ];
  return scenario === "reverse-branch" ? values : values.slice(0, 4);
}

function historyPoints(filters: HistoryFilters, seed: number): readonly HistoryPoint[] {
  const result: HistoryPoint[] = [];
  let date = filters.from;
  let absoluteIndex = 0;
  while (date <= filters.to) {
    const weekday = calendarDayOfWeek(date);
    if (filters.weekdays.length === 0 || filters.weekdays.includes(weekday)) {
      const hourSeed = filters.hour ?? 12;
      const directionSeed = filters.direction === null ? 2 : filters.direction * 11;
      const scheduled = 190 + ((absoluteIndex + seed + hourSeed) % 9) * 13 + directionSeed;
      const observed = Math.round(scheduled * (0.82 + ((absoluteIndex + seed + directionSeed) % 5) * 0.025));
      const mean = 120 + ((absoluteIndex * 43 + seed * 17 + hourSeed * 19 + directionSeed * 23) % 260);
      result.push({ date, scheduled, observed, punctuality: Math.max(0.42, 0.82 - mean / 1600), meanDelaySeconds: mean, coverage: observed / scheduled });
    }
    date = offsetCalendarDate(date, 1);
    absoluteIndex += 1;
  }
  return result;
}

function rankingItem(id: string, label: string, seed: number): RankingItem {
  const sample = 140 + seed * 21;
  return { id, label, sample, meanDelaySeconds: 160 + seed * 37, punctuality: Math.max(0.42, 0.84 - seed * 0.045) };
}

function fixtureInsights(kind: "network" | "line" | "station", scenario: FixtureScenario): HistoryResponse["insights"] {
  const unsupported = scenario === "unsupported-capabilities";
  const stationValues = fixtureStations.slice(0, 6).map((station, index) => rankingItem(station.id, station.name.es, index + 1));
  const hourValues = [8, 18, 9, 19, 7].map((hour, index) => rankingItem(String(hour), `${String(hour).padStart(2, "0")}:00`, index + 1));
  const hourWeekday: HourWeekdayItem[] = Array.from({ length: 7 * 24 }, (_, index) => {
    const weekday = index % 7;
    const hour = Math.floor(index / 7);
    const scheduled = 70 + ((weekday * 17 + hour * 13) % 80);
    const sample = Math.round(scheduled * (0.78 + ((weekday + hour) % 5) * 0.04));
    return { weekday, hour, scheduled, sample, meanDelaySeconds: 90 + ((weekday * 41 + hour * 23) % 520), coverage: sample / scheduled };
  });
  const volumeReliability: VolumeReliabilityItem[] = (kind === "network" ? fixtureLines.slice(0, 8).map((line, index) => ({ id: line.id, label: line.code, scheduled: 230 + index * 54, ...rankingItem(line.id, line.code, index + 1), coverage: 0.82 + (index % 4) * 0.035 })) : stationValues.map((item, index) => ({ ...item, scheduled: item.sample + 30 + index * 7, coverage: item.sample / (item.sample + 30 + index * 7) })));
  const segments: SegmentDelayItem[] = kind === "line" ? fixtureStations.slice(0, 5).flatMap((station, index) => {
    const next = fixtureStations[index + 1];
    if (next === undefined) return [];
    return [0, 1].map((direction) => ({ id: `${station.id}-${next.id}-${direction}`, label: `${station.name.es} → ${next.name.es}`, direction: direction as 0 | 1, sample: 180 + index * 23, addedDelaySeconds: 18 + index * 21 + direction * 9 }));
  }) : [];
  const available = <T,>(value: readonly T[]): Capability<readonly T[]> => unsupported ? { status: "unavailable", reason: "not-supported" } : value.length === 0 ? { status: "insufficient-sample" } : { status: "available", value };
  return {
    stations: kind === "station" ? { status: "unavailable", reason: "not-supported" } : available(stationValues),
    hours: available(hourValues),
    hourWeekday: available(hourWeekday),
    volumeReliability: available(volumeReliability),
    segments: kind === "line" ? available(segments) : { status: "unavailable", reason: "not-supported" },
    scheduleSlots: { status: "unavailable", reason: "not-supported" },
  };
}

export function historyResponse(filters: HistoryFilters, kind: "network" | "line" | "station", label: string, id: string, slug: HistoryResponse["context"]["slug"], seed: number, scenario: FixtureScenario): HistoryResponse {
  const trend = historyPoints(filters, seed);
  const scheduled = trend.reduce((sum, point) => sum + point.scheduled, 0);
  const observed = trend.reduce((sum, point) => sum + point.observed, 0);
  const weightedDelay = trend.reduce((sum, point) => sum + (point.meanDelaySeconds ?? 0) * point.observed, 0);
  const base: SummaryStats = {
    scheduled,
    observed,
    punctuality: observed === 0 ? null : trend.reduce((sum, point) => sum + (point.punctuality ?? 0) * point.observed, 0) / observed,
    meanDelaySeconds: observed === 0 ? null : Math.round(weightedDelay / observed),
    medianDelaySeconds: observed === 0 ? null : 150 + seed * 12 + (filters.hour ?? 0),
    p90DelaySeconds: observed === 0 ? null : 480 + seed * 21 + (filters.hour ?? 0),
    canceled: Math.round(scheduled * 0.012),
    missing: Math.max(0, scheduled - observed),
    distribution: distributionFromCounts({ early: Math.round(observed * 0.06), punctual: Math.round(observed * 0.61), "delay-2-5": Math.round(observed * 0.17), "delay-5-10": Math.round(observed * 0.09), "delay-10-15": Math.round(observed * 0.045), "delay-15-plus": Math.round(observed * 0.025) }),
  };
  const stats = statsForScenario(base, scenario);
  const ranked = linePerformance(scenario)
    .flatMap((line) => line.stats.status === "available" ? [{ line, stats: line.stats.value }] : [])
    .sort((left, right) => (right.stats.meanDelaySeconds ?? 0) - (left.stats.meanDelaySeconds ?? 0))
    .slice(0, 5)
    .map(({ line, stats: itemStats }) => ({ id: line.id, label: line.code, sample: itemStats.observed, meanDelaySeconds: itemStats.meanDelaySeconds, punctuality: itemStats.punctuality }));
  const rankings = kind !== "network" || scenario === "unsupported-capabilities"
    ? { status: "unavailable" as const, reason: "not-supported" as const }
    : ranked.length === 0
      ? { status: "insufficient-sample" as const }
      : { status: "available" as const, value: ranked };
  return {
    meta: historyMeta(scenario, stats, filters),
    context: { kind, label, id: kind === "network" ? MADRID_NETWORK.slug : id, slug },
    filters,
    stats,
    trend,
    rankings,
    insights: fixtureInsights(kind, scenario),
    directions: [
      { id: 0, headsign: null, from: kind === "line" ? fixtureStations[0]! : null, to: kind === "line" ? fixtureStations[5]! : null },
      { id: 1, headsign: null, from: kind === "line" ? fixtureStations[5]! : null, to: kind === "line" ? fixtureStations[0]! : null },
    ],
  };
}

export function comparison(scenario: FixtureScenario, seed: number): Capability<Comparison> {
  if (scenario === "unsupported-capabilities") return { status: "unavailable", reason: "not-supported" };
  if (scenario === "incomplete" || scenario === "zero-observed") return { status: "insufficient-sample" };
  return { status: "available", value: { sample: 188 + seed * 9, punctuality: 0.81 - seed * 0.02, meanDelaySeconds: 146 + seed * 18 } };
}

function syntheticStation(index: number) {
  return {
    id: `synthetic-${index}`,
    slug: { es: `estacion-sintetica-${index}`, en: `synthetic-station-${index}` },
    name: { es: `Estación sintética ${index}`, en: `Synthetic station ${index}` },
  };
}

export function matrixResponse(scenario: FixtureScenario): MatrixResponse {
  const large = scenario === "large-matrix";
  const stations = large ? Array.from({ length: 32 }, (_, index) => syntheticStation(index + 1)) : fixtureStations.slice(0, 6);
  const journeyCount = large ? 90 : 7;
  const journeys: MatrixJourney[] = Array.from({ length: journeyCount }, (_, index) => ({
    id: `mx-${index + 1}`,
    label: `C1 ${String(700 + index * 13)}`,
    direction: { id: index % 2 === 0 ? 0 : 1, headsign: null, from: null, to: null },
  }));
  const cells: MatrixCell[] = [];
  for (const [journeyIndex, journey] of journeys.entries()) for (const [stationIndex, station] of stations.entries()) {
    const scheduled = new Date(Date.UTC(2026, 7, 24, 5, 10 + journeyIndex * 4 + stationIndex * 2)).toISOString();
    let state: EvidenceState = stationIndex + journeyIndex > journeyCount + stations.length - 8 && scenario !== "finalized" ? "pending" : "reported_only";
    if (scenario === "cancellations" && journeyIndex === 3 && stationIndex >= 3) state = "canceled";
    if (scenario === "missing" && (journeyIndex + stationIndex) % 8 === 0) state = "missing_evidence";
    if (scenario === "missing" && (journeyIndex + stationIndex) % 11 === 0) state = "skipped";
    const delay = state === "canceled" || state === "skipped" || state === "missing_evidence" || state === "pending" ? null : ((journeyIndex * 97 + stationIndex * 61) % 820) - 45;
    cells.push({ journeyId: journey.id, stationId: station.id, scheduledAt: scheduled, reportedAt: delay === null ? null : new Date(Date.parse(scheduled) + delay * 1000).toISOString(), delaySeconds: delay, state });
  }
  const stats = statsForScenario({ ...baseStats, scheduled: cells.length, observed: cells.filter((cell) => cell.delaySeconds !== null).length }, scenario);
  return { meta: historyMeta(scenario, stats, { from: FIXTURE_TODAY, to: FIXTURE_TODAY, weekdays: [], hour: null, direction: null }), line: fixtureLines[0]!, date: FIXTURE_TODAY, stations, journeys, cells };
}
