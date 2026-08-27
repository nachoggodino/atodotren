import type { Confidence, DirectionDescriptor, InformationOrigin, LineRef, StationRef, TrainDetail, TrainFieldEvidence, TrainPosition } from "@/lib/domain/contracts";
import type { JourneyRow, LiveVehicleRow } from "../row-parser";

function evidence(origin: InformationOrigin, confidence: Confidence): TrainFieldEvidence {
  return { origin, confidence };
}

const unavailableEvidence = evidence("unavailable", "unavailable");

function stationFromColumns(
  id: string | null,
  slugEs: string | null,
  slugEn: string | null,
  nameEs: string | null,
  nameEn: string | null,
): StationRef | null {
  if (id === null || slugEs === null || slugEn === null || nameEs === null || nameEn === null) return null;
  return { id, slug: { es: slugEs, en: slugEn }, name: { es: nameEs, en: nameEn } };
}

function currentStationFromLive(row: LiveVehicleRow): StationRef | null {
  return stationFromColumns(row.currentStationId, row.currentStationSlugEs, row.currentStationSlugEn, row.currentStationNameEs, row.currentStationNameEn);
}

function previousStationFromLive(row: LiveVehicleRow): StationRef | null {
  return stationFromColumns(row.previousStationId, row.previousStationSlugEs, row.previousStationSlugEn, row.previousStationNameEs, row.previousStationNameEn);
}

function nextStationFromLive(row: LiveVehicleRow): StationRef | null {
  return stationFromColumns(row.nextStationId, row.nextStationSlugEs, row.nextStationSlugEn, row.nextStationNameEs, row.nextStationNameEn);
}

function originStationFromLive(row: LiveVehicleRow): StationRef | null {
  return stationFromColumns(row.originStationId, row.originStationSlugEs, row.originStationSlugEn, row.originStationNameEs, row.originStationNameEn);
}

function destinationStationFromLive(row: LiveVehicleRow): StationRef | null {
  return stationFromColumns(row.destinationStationId, row.destinationStationSlugEs, row.destinationStationSlugEn, row.destinationStationNameEs, row.destinationStationNameEn);
}

function localized(value: string | null) {
  return value === null ? null : { es: value, en: value };
}

function probableArrival(scheduledAt: string | null, delaySeconds: number | null): string | null {
  if (scheduledAt === null || delaySeconds === null) return null;
  return new Date(Date.parse(scheduledAt) + delaySeconds * 1000).toISOString();
}

export function liveTrainFromRow(row: LiveVehicleRow, line: LineRef): TrainDetail {
  const feedStation = currentStationFromLive(row);
  const previousStation = previousStationFromLive(row);
  const nextStation = nextStationFromLive(row);
  const originStation = originStationFromLive(row);
  const destination = destinationStationFromLive(row);
  const stopped = row.currentStatus === "STOPPED_AT" && feedStation !== null;
  const moving = (row.currentStatus === "IN_TRANSIT_TO" || row.currentStatus === "INCOMING_AT") && previousStation !== null && nextStation !== null;
  const currentStation = stopped ? feedStation : null;
  const position: TrainPosition = stopped
    ? { kind: "at_station", stationId: feedStation.id, basis: "reported-stop", confidence: "high" }
    : moving
      ? { kind: "between_stations", fromStationId: previousStation.id, toStationId: nextStation.id, progress: null, basis: "feed-inferred", confidence: "medium" }
      : { kind: "unknown", stationHintId: feedStation?.id ?? nextStation?.id ?? null, basis: "unavailable", confidence: feedStation === null && nextStation === null ? "unavailable" : "low" };
  const delaySeconds = row.latestUsableDelay ?? row.latestStopDelay;
  const sourceAt = row.latestDelaySourceAt ?? row.vehicleSourceAt ?? row.capturedAt;
  const direction: DirectionDescriptor | null = row.direction === null
    ? null
    : { id: row.direction, headsign: localized(row.headsign), from: originStation, to: destination };
  const headsign = localized(row.headsign);
  const scheduledArrivalAt = row.scheduledNextArrivalAt;
  const probableArrivalAt = probableArrival(scheduledArrivalAt, delaySeconds);
  const observedPastArrivalAt = row.previousObservedPresenceAt ?? row.previousReportedArrivalAt;
  return {
    id: row.vehicleId ?? row.stateKey,
    journeyId: row.journeyId ?? row.sourceTripId,
    serviceDate: row.serviceDate,
    line,
    patternId: row.patternId,
    direction,
    headsign,
    destination,
    currentStation,
    previousStation,
    nextStation,
    position,
    scheduledArrivalAt,
    probableArrivalAt,
    renfeReportedArrivalAt: row.reportedNextArrivalAt,
    observedPresenceAt: stopped ? row.vehicleSourceAt ?? row.capturedAt : null,
    observedPastArrivalAt,
    delaySeconds,
    state: stopped ? "observed_presence" : delaySeconds === null ? "pending" : "reported_only",
    sourceAt,
    information: {
      servicePattern: row.patternId === null ? unavailableEvidence : evidence("inferred", "high"),
      direction: direction === null ? unavailableEvidence : evidence("inferred", "high"),
      headsign: headsign === null ? unavailableEvidence : evidence("reported", "high"),
      destination: destination === null ? unavailableEvidence : evidence("inferred", "high"),
      currentStation: currentStation === null ? unavailableEvidence : evidence("reported", "high"),
      previousStation: previousStation === null ? unavailableEvidence : evidence("inferred", "medium"),
      nextStation: nextStation === null ? unavailableEvidence : evidence(row.currentStatus === "STOPPED_AT" ? "inferred" : "reported", "medium"),
      scheduledArrival: scheduledArrivalAt === null ? unavailableEvidence : evidence("reported", "high"),
      probableArrival: probableArrivalAt === null ? unavailableEvidence : evidence("inferred", "medium"),
      reportedArrival: row.reportedNextArrivalAt === null ? unavailableEvidence : evidence("reported", "high"),
      observedPresence: stopped ? evidence("reported", "high") : observedPastArrivalAt === null ? unavailableEvidence : evidence("reported", "high"),
      delay: delaySeconds === null ? unavailableEvidence : evidence("reported", "high"),
    },
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
  const destination = stations.at(-1) ?? null;
  const observedPastArrivalAt = [...rows].reverse().find((row) => row.observedPresenceAt !== null || row.renfeArrivalAt !== null)?.observedPresenceAt
    ?? [...rows].reverse().find((row) => row.renfeArrivalAt !== null)?.renfeArrivalAt
    ?? null;
  return {
    id: first.sourceTripId,
    journeyId: first.journeyId,
    serviceDate: first.serviceDate,
    line,
    patternId: null,
    direction: directionFromJourney(first.direction, stations),
    headsign: null,
    destination,
    currentStation: null,
    previousStation: stations.length > 1 ? stations.at(-2) ?? null : null,
    nextStation: destination,
    position: { kind: "unknown", stationHintId: last.stationId, basis: "unavailable", confidence: "unavailable" },
    scheduledArrivalAt: scheduled,
    probableArrivalAt: probableArrival(scheduled, delay),
    renfeReportedArrivalAt: last.renfeArrivalAt,
    observedPresenceAt: last.observedPresenceAt,
    observedPastArrivalAt,
    delaySeconds: delay,
    state: last.evidenceState,
    sourceAt: last.sourceAt,
    information: {
      servicePattern: unavailableEvidence,
      direction: evidence("inferred", "high"),
      headsign: unavailableEvidence,
      destination: destination === null ? unavailableEvidence : evidence("inferred", "high"),
      currentStation: unavailableEvidence,
      previousStation: stations.length > 1 ? evidence("inferred", "medium") : unavailableEvidence,
      nextStation: destination === null ? unavailableEvidence : evidence("inferred", "medium"),
      scheduledArrival: scheduled === null ? unavailableEvidence : evidence("reported", "high"),
      probableArrival: scheduled === null || delay === null ? unavailableEvidence : evidence("inferred", "medium"),
      reportedArrival: last.renfeArrivalAt === null ? unavailableEvidence : evidence("reported", "high"),
      observedPresence: observedPastArrivalAt === null ? unavailableEvidence : evidence("reported", "high"),
      delay: delay === null ? unavailableEvidence : evidence("reported", "high"),
    },
  };
}
