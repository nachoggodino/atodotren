import type { DirectionDescriptor, LineRef, StationRef, TrainDetail, TrainPosition } from "@/lib/domain/contracts";
import type { JourneyRow, LiveVehicleRow } from "../row-parser";

function isStopped(status: string): boolean {
  const normalized = status.toUpperCase();
  return normalized.includes("STOPPED") || normalized.includes("AT_STOP");
}

function stationFromLive(row: LiveVehicleRow): StationRef | null {
  if (row.currentStationId === null || row.currentStationSlugEs === null || row.currentStationSlugEn === null || row.currentStationNameEs === null || row.currentStationNameEn === null) return null;
  return { id: row.currentStationId, slug: { es: row.currentStationSlugEs, en: row.currentStationSlugEn }, name: { es: row.currentStationNameEs, en: row.currentStationNameEn } };
}

export function liveTrainFromRow(row: LiveVehicleRow, line: LineRef): TrainDetail {
  const currentStation = stationFromLive(row);
  const position: TrainPosition = isStopped(row.currentStatus) && currentStation !== null
    ? { kind: "at_station", stationId: currentStation.id, basis: "reported-stop", confidence: "medium" }
    : { kind: "unknown", stationHintId: currentStation?.id ?? null, basis: "unavailable", confidence: currentStation === null ? "unavailable" : "low" };
  return {
    id: row.vehicleId ?? row.stateKey,
    journeyId: row.journeyId ?? row.sourceTripId,
    serviceDate: row.serviceDate,
    line,
    patternId: null,
    direction: null,
    headsign: null,
    destination: null,
    position,
    scheduledArrivalAt: null,
    probableArrivalAt: null,
    renfeReportedArrivalAt: null,
    observedPresenceAt: position.kind === "at_station" ? row.vehicleTimestamp ?? row.capturedAt : null,
    delaySeconds: row.latestStopDelay,
    state: position.kind === "at_station" ? "observed_presence" : row.latestStopDelay === null ? "pending" : "reported_only",
    sourceAt: row.vehicleTimestamp ?? row.capturedAt,
  };
}

function directionFromJourney(id: 0 | 1, stations: readonly StationRef[]): DirectionDescriptor {
  return { id, headsign: null, from: stations[0] ?? null, to: stations.at(-1) ?? null };
}

export function journeyFromRows(rows: readonly JourneyRow[], line: LineRef): TrainDetail | null {
  const first = rows[0];
  const last = rows.at(-1);
  if (first === undefined || last === undefined) return null;
  const stations = rows.map<StationRef>((row) => ({ id: row.stationId, slug: { es: row.stationId, en: row.stationId }, name: { es: row.stationNameEs, en: row.stationNameEn } }));
  const scheduled = last.scheduledArrivalAt;
  const delay = last.selectedDelaySeconds;
  return {
    id: first.sourceTripId,
    journeyId: first.journeyId,
    serviceDate: first.serviceDate,
    line,
    patternId: null,
    direction: directionFromJourney(first.direction, stations),
    headsign: null,
    destination: stations.at(-1) ?? null,
    position: { kind: "unknown", stationHintId: last.stationId, basis: "unavailable", confidence: "unavailable" },
    scheduledArrivalAt: scheduled,
    probableArrivalAt: scheduled === null || delay === null ? null : new Date(Date.parse(scheduled) + delay * 1000).toISOString(),
    renfeReportedArrivalAt: last.renfeArrivalAt,
    observedPresenceAt: last.observedPresenceAt,
    delaySeconds: delay,
    state: last.evidenceState,
    sourceAt: last.sourceAt,
  };
}
