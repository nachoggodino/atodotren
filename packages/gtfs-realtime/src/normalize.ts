import { createHash } from 'node:crypto';

import { matchTrip, resolveStop } from './matcher.js';
import { inferCandidateServiceDate, type ServiceDateAnchor } from './service-date.js';
import type {
  AlertTargetOperation,
  DecodedAlert,
  DecodedEntity,
  DecodedFeed,
  InvalidEntity,
  MatchingMethod,
  NormalizedBatch,
  PendingOperation,
  QuarantineOperation,
  ResolvedMatch,
  ServiceAlertOperation,
  StaticMatchIndex,
  StaticTripCandidate,
  StopEvidenceOperation,
  TripDescriptor,
  VehicleStateOperation,
} from './types.js';

export const MATCHING_VERSION = 'madrid-v1';
export const FILTERED_PAYLOAD_CODEC = 'madrid-json-gzip-v1';

interface ServiceDateResolution {
  readonly value?: string | undefined;
  readonly source: 'provided' | 'inferred' | 'missing';
}

export function inferenceServiceDates(capturedAt: Date): readonly string[] {
  if (Number.isNaN(capturedAt.getTime())) throw new RangeError('capturedAt must be valid');
  const utcDay = Date.UTC(capturedAt.getUTCFullYear(), capturedAt.getUTCMonth(), capturedAt.getUTCDate());
  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date(utcDay + (index - 4) * 86_400_000);
    return date.toISOString().slice(0, 10);
  });
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

export function checksum(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function serviceDate(descriptor: TripDescriptor): string | undefined {
  const value = descriptor.startDate;
  return value !== undefined && /^\d{8}$/u.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : undefined;
}

function resolveServiceDate(
  candidate: StaticTripCandidate,
  descriptor: TripDescriptor,
  anchors: readonly ServiceDateAnchor[],
  capturedAt: string,
): ServiceDateResolution {
  const provided = serviceDate(descriptor);
  if (provided !== undefined) return { value: provided, source: 'provided' };
  const inferred = inferCandidateServiceDate(candidate, anchors, Math.floor(new Date(capturedAt).getTime() / 1000));
  return inferred === undefined ? { source: 'missing' } : { value: inferred.date, source: 'inferred' };
}

function quarantine(
  feed: DecodedFeed,
  capturedAt: string,
  invalid: InvalidEntity,
): QuarantineOperation {
  const identity = {
    feedKind: feed.feedKind, headerTimestamp: feed.headerTimestamp,
    capturedAt, ...invalid,
  };
  return {
    kind: 'quarantine',
    idempotencyKey: checksum(identity),
    capturedAt,
    feedKind: feed.feedKind,
    feedHeaderTimestamp: feed.headerTimestamp,
    ...invalid,
  };
}

function plausibleMadrid(invalid: InvalidEntity): boolean {
  return invalid.routeId === undefined || invalid.routeId.startsWith('10');
}

function matchMethod(match: ResolvedMatch): MatchingMethod {
  if (!match.disposition.includes('exact-trip') && !match.disposition.includes('unique-fallback')) {
    throw new Error(`Cannot use unresolved matching disposition ${match.disposition}`);
  }
  return match.disposition as MatchingMethod;
}

function evidenceBase(
  candidate: StaticTripCandidate,
  descriptor: TripDescriptor,
  resolvedServiceDate: string | undefined,
): string {
  return [candidate.feedVersionId, candidate.tripId, resolvedServiceDate ?? '-', descriptor.startTime ?? '-'].join(':');
}

function evidenceOperation(input: Omit<StopEvidenceOperation, 'idempotencyKey' | 'evidenceChecksum'>): StopEvidenceOperation {
  const semantic = {
    evidenceKey: input.evidenceKey,
    arrivalTime: input.arrivalTime ?? null,
    arrivalDelay: input.arrivalDelay ?? null,
    tripRelationship: input.tripRelationship,
    stopRelationship: input.stopRelationship,
    classification: input.classification,
  };
  const evidenceChecksum = checksum(semantic);
  return {
    ...input,
    evidenceChecksum,
    idempotencyKey: checksum([input.evidenceKey, evidenceChecksum, input.capturedAt]),
  };
}

function normalizeTripEntity(
  feed: DecodedFeed,
  entity: Extract<DecodedEntity, { kind: 'trip_update' }>,
  capturedAt: string,
  index: StaticMatchIndex,
): { operations: PendingOperation[]; filtered?: unknown; disposition: string; invalid: boolean } {
  const match = matchTrip(index, entity.trip, entity.stopUpdates, {
    fallbackInstantSeconds: entity.timestamp ?? Math.floor(new Date(capturedAt).getTime() / 1000),
  });
  if (match.candidate === undefined) {
    if (match.disposition === 'ambiguous') {
      return {
        operations: [quarantine(feed, capturedAt, {
          entityId: entity.entityId,
          ...(entity.trip.tripId === undefined ? {} : { tripId: entity.trip.tripId }),
          ...(entity.trip.routeId === undefined ? {} : { routeId: entity.trip.routeId }),
          reasonCode: 'matching.ambiguous', diagnosticFields: {},
        })],
        disposition: match.disposition, invalid: true,
      };
    }
    return { operations: [], disposition: match.disposition, invalid: false };
  }
  const candidate = match.candidate;
  const matchingMethod = matchMethod(match);
  const anchors = entity.stopUpdates.flatMap((update): ServiceDateAnchor[] => {
    if (update.arrivalTime === undefined) return [];
    const stop = resolveStop(candidate, update).stop;
    return stop?.arrivalSeconds === undefined ? [] : [{
      instantSeconds: update.arrivalTime,
      scheduledSeconds: stop.arrivalSeconds,
    }];
  });
  if (anchors.length === 0 && entity.timestamp !== undefined && candidate.firstTimeSeconds !== undefined) {
    anchors.push({ instantSeconds: entity.timestamp, scheduledSeconds: candidate.firstTimeSeconds });
  }
  const resolvedDate = resolveServiceDate(candidate, entity.trip, anchors, capturedAt);
  const base = evidenceBase(candidate, entity.trip, resolvedDate.value);
  const operations: PendingOperation[] = [];
  if (entity.trip.scheduleRelationship === 'CANCELED') {
    operations.push(evidenceOperation({
      kind: 'stop_evidence', evidenceKey: `${base}:trip-cancellation`, capturedAt,
      feedKind: 'trip_updates', feedVersionId: candidate.feedVersionId,
      sourceTripId: candidate.tripId,
      ...(resolvedDate.value === undefined ? {} : { serviceDate: resolvedDate.value }),
      ...(entity.trip.startTime === undefined ? {} : { startTime: entity.trip.startTime }),
      startDateSource: resolvedDate.source,
      tripRelationship: entity.trip.scheduleRelationship, stopRelationship: 'NOT_APPLICABLE',
      ...(entity.timestamp === undefined ? {} : { sourceTimestamp: entity.timestamp }),
      matchingMethod, matchingVersion: MATCHING_VERSION, classification: 'trip_cancellation',
    }));
  }
  let entityInvalid = false;
  for (const update of entity.stopUpdates) {
    const resolved = resolveStop(candidate, update);
    if (resolved.stop === undefined) {
      if (resolved.ambiguous || update.stopSequence !== undefined || update.stopId !== undefined) {
        entityInvalid = true;
        operations.push(quarantine(feed, capturedAt, {
          entityId: entity.entityId, tripId: candidate.tripId,
          ...(entity.trip.routeId === undefined ? {} : { routeId: entity.trip.routeId }),
          ...(update.stopId === undefined ? {} : { stopId: update.stopId }),
          reasonCode: resolved.ambiguous ? 'matching.stop_ambiguous' : 'matching.stop_unknown',
          diagnosticFields: { ...(update.stopSequence === undefined ? {} : { stopSequence: update.stopSequence }) },
        }));
      }
      continue;
    }
    const stop = resolved.stop;
    const skipped = update.relationship === 'SKIPPED';
    if (!skipped && update.arrivalTime === undefined && update.arrivalDelay === undefined) continue;
    const classification = skipped ? 'stop_skipped' : 'reported_prediction';
    const evidenceKey = `${base}:stop:${stop.stopSequence}:${classification}`;
    operations.push(evidenceOperation({
      kind: 'stop_evidence', evidenceKey, capturedAt, feedKind: 'trip_updates',
      feedVersionId: candidate.feedVersionId, sourceTripId: candidate.tripId,
      ...(resolvedDate.value === undefined ? {} : { serviceDate: resolvedDate.value }),
      ...(entity.trip.startTime === undefined ? {} : { startTime: entity.trip.startTime }),
      startDateSource: resolvedDate.source,
      stopId: stop.stopId, stopSequence: stop.stopSequence, stationId: stop.stationId,
      ...(update.arrivalTime === undefined ? {} : { arrivalTime: update.arrivalTime }),
      ...(update.arrivalDelay === undefined ? {} : { arrivalDelay: update.arrivalDelay }),
      tripRelationship: entity.trip.scheduleRelationship,
      stopRelationship: update.relationship,
      ...(entity.timestamp === undefined ? {} : { sourceTimestamp: entity.timestamp }),
      matchingMethod, matchingVersion: MATCHING_VERSION, classification,
    }));
  }
  return {
    operations,
    filtered: { entityId: entity.entityId, trip: entity.trip, stopUpdates: entity.stopUpdates, timestamp: entity.timestamp },
    disposition: match.disposition,
    invalid: entityInvalid,
  };
}

function normalizeVehicleEntity(
  feed: DecodedFeed,
  entity: Extract<DecodedEntity, { kind: 'vehicle_position' }>,
  capturedAt: string,
  index: StaticMatchIndex,
): { operations: PendingOperation[]; filtered?: unknown; disposition: string; invalid: boolean } {
  const stopHint = { stopSequence: entity.currentStopSequence, stopId: entity.stopId };
  const match = matchTrip(index, entity.trip, [stopHint], {
    fallbackInstantSeconds: entity.timestamp ?? Math.floor(new Date(capturedAt).getTime() / 1000),
  });
  if (match.candidate === undefined) {
    if (match.disposition === 'ambiguous') {
      return {
        operations: [quarantine(feed, capturedAt, {
          entityId: entity.entityId,
          ...(entity.trip.tripId === undefined ? {} : { tripId: entity.trip.tripId }),
          ...(entity.trip.routeId === undefined ? {} : { routeId: entity.trip.routeId }),
          reasonCode: 'matching.ambiguous', diagnosticFields: {},
        })], disposition: match.disposition, invalid: true,
      };
    }
    return { operations: [], disposition: match.disposition, invalid: false };
  }
  const candidate = match.candidate;
  const matchingMethod = matchMethod(match);
  const resolved = resolveStop(candidate, stopHint);
  if (resolved.ambiguous) {
    return {
      operations: [quarantine(feed, capturedAt, {
        entityId: entity.entityId, tripId: candidate.tripId,
        ...(entity.stopId === undefined ? {} : { stopId: entity.stopId }),
        reasonCode: 'matching.stop_ambiguous', diagnosticFields: {},
      })], disposition: 'ambiguous', invalid: true,
    };
  }
  const anchors: ServiceDateAnchor[] = [];
  const instantSeconds = entity.timestamp ?? Math.floor(new Date(capturedAt).getTime() / 1000);
  const scheduledSeconds = resolved.stop?.arrivalSeconds ?? candidate.firstTimeSeconds;
  if (scheduledSeconds !== undefined) anchors.push({ instantSeconds, scheduledSeconds });
  const resolvedDate = resolveServiceDate(candidate, entity.trip, anchors, capturedAt);
  const instance = evidenceBase(candidate, entity.trip, resolvedDate.value);
  const stateKey = `${instance}:vehicle:${entity.vehicleId ?? entity.entityId}`;
  const projectionInput = entity.latitude !== undefined ? 'raw_position'
    : entity.currentStopSequence !== undefined ? 'stop_sequence'
      : entity.stopId !== undefined ? 'stop_id' : 'none';
  const projectionConfidence = projectionInput === 'stop_sequence' ? 0.8
    : projectionInput === 'stop_id' ? 0.6 : projectionInput === 'raw_position' ? 0.5 : undefined;
  const stateSemantic = {
    stateKey, latitude: entity.latitude, longitude: entity.longitude, bearing: entity.bearing,
    speed: entity.speed, currentStopSequence: resolved.stop?.stopSequence ?? entity.currentStopSequence,
    currentStopId: resolved.stop?.stopId ?? entity.stopId, currentStatus: entity.currentStatus,
    vehicleTimestamp: entity.timestamp, feedHeaderTimestamp: feed.headerTimestamp,
  };
  const state: VehicleStateOperation = {
    kind: 'vehicle_state', idempotencyKey: checksum([stateSemantic, capturedAt]), stateKey, capturedAt,
    feedVersionId: candidate.feedVersionId, sourceTripId: candidate.tripId,
    ...(resolvedDate.value === undefined ? {} : { serviceDate: resolvedDate.value }),
    ...(entity.trip.startTime === undefined ? {} : { startTime: entity.trip.startTime }),
    lineId: candidate.lineId, branchId: candidate.branchId, servicePatternId: candidate.servicePatternId,
    ...(entity.vehicleId === undefined ? {} : { vehicleId: entity.vehicleId }), entityId: entity.entityId,
    ...(entity.latitude === undefined ? {} : { latitude: entity.latitude }),
    ...(entity.longitude === undefined ? {} : { longitude: entity.longitude }),
    ...(entity.bearing === undefined ? {} : { bearing: entity.bearing }),
    ...(entity.speed === undefined ? {} : { speed: entity.speed }),
    ...(resolved.stop?.stopSequence === undefined && entity.currentStopSequence === undefined ? {} :
      { currentStopSequence: resolved.stop?.stopSequence ?? entity.currentStopSequence }),
    ...(resolved.stop?.stopId === undefined && entity.stopId === undefined ? {} :
      { currentStopId: resolved.stop?.stopId ?? entity.stopId }),
    ...(resolved.stop === undefined ? {} : { currentStationId: resolved.stop.stationId }),
    currentStatus: entity.currentStatus,
    ...(entity.timestamp === undefined ? {} : { vehicleTimestamp: entity.timestamp }),
    feedHeaderTimestamp: feed.headerTimestamp,
    ...(candidate.shapeId === undefined ? {} : { shapeId: candidate.shapeId }),
    projectionInput,
    ...(projectionConfidence === undefined ? {} : { projectionConfidence }),
    contentChecksum: checksum(stateSemantic),
  };
  const operations: PendingOperation[] = [state];
  if (entity.currentStatus === 'STOPPED_AT' && entity.timestamp !== undefined && resolved.stop !== undefined) {
    const stop = resolved.stop;
    operations.push(evidenceOperation({
      kind: 'stop_evidence', evidenceKey: `${instance}:stop:${stop.stopSequence}:observed-presence`,
      capturedAt, feedKind: 'vehicle_positions', feedVersionId: candidate.feedVersionId,
      sourceTripId: candidate.tripId,
      ...(resolvedDate.value === undefined ? {} : { serviceDate: resolvedDate.value }),
      ...(entity.trip.startTime === undefined ? {} : { startTime: entity.trip.startTime }),
      startDateSource: resolvedDate.source,
      stopId: stop.stopId, stopSequence: stop.stopSequence, stationId: stop.stationId,
      tripRelationship: entity.trip.scheduleRelationship, stopRelationship: 'STOPPED_AT',
      sourceTimestamp: entity.timestamp, matchingMethod, matchingVersion: MATCHING_VERSION,
      classification: 'observed_presence',
    }));
  }
  return {
    operations,
    filtered: { entityId: entity.entityId, trip: entity.trip, vehicleId: entity.vehicleId,
      timestamp: entity.timestamp, latitude: entity.latitude, longitude: entity.longitude,
      currentStopSequence: entity.currentStopSequence, stopId: entity.stopId, currentStatus: entity.currentStatus },
    disposition: match.disposition, invalid: false,
  };
}

function alertTarget(
  target: DecodedAlert['targets'][number],
  index: StaticMatchIndex,
  order: number,
): AlertTargetOperation | undefined {
  const route = target.routeId === undefined ? undefined : index.alertRoutes?.get(target.routeId);
  const stop = target.stopId === undefined ? undefined : index.alertStops?.get(target.stopId);
  const tripMatch = target.trip === undefined ? undefined : matchTrip(index, target.trip);
  const trip = tripMatch?.candidate;
  if ((target.routeId !== undefined && route === undefined) ||
      (target.stopId !== undefined && stop === undefined) ||
      (target.trip !== undefined && trip === undefined)) return undefined;
  const feedVersionId = trip?.feedVersionId ?? route?.feedVersionId ?? stop?.feedVersionId;
  if (feedVersionId === undefined) return undefined;
  return {
    order, feedVersionId,
    ...(target.routeId === undefined ? {} : { routeId: target.routeId }),
    ...(route === undefined ? {} : { lineId: route.lineId }),
    ...(target.stopId === undefined ? {} : { stopId: target.stopId }),
    ...(stop === undefined ? {} : { stationId: stop.stationId }),
    ...(trip === undefined ? {} : { tripId: trip.tripId }),
  };
}

function normalizeAlertEntity(
  feed: DecodedFeed,
  entity: Extract<DecodedEntity, { kind: 'alert' }>,
  capturedAt: string,
  index: StaticMatchIndex,
): { operations: PendingOperation[]; filtered?: unknown; disposition: string; invalid: boolean } {
  const targets = entity.targets.map((target, order) => alertTarget(target, index, order))
    .filter((target): target is AlertTargetOperation => target !== undefined);
  if (targets.length === 0) return { operations: [], disposition: 'non-madrid', invalid: false };
  const semantic = {
    activePeriods: entity.activePeriods, cause: entity.cause, effect: entity.effect,
    headerText: entity.headerText, descriptionText: entity.descriptionText,
    url: entity.url, targets,
  };
  const contentChecksum = checksum(semantic);
  const operation: ServiceAlertOperation = {
    kind: 'service_alert', idempotencyKey: checksum([entity.entityId, contentChecksum]),
    sourceAlertId: entity.entityId, feedHeaderTimestamp: feed.headerTimestamp, capturedAt,
    activePeriods: entity.activePeriods, cause: entity.cause, effect: entity.effect,
    headerText: entity.headerText, descriptionText: entity.descriptionText,
    ...(entity.url === undefined ? {} : { url: entity.url }), contentChecksum, targets,
  };
  return { operations: [operation], filtered: { entityId: entity.entityId, ...semantic }, disposition: 'active-exact-trip', invalid: false };
}

export function normalizeFeed(feed: DecodedFeed, capturedAt: Date, index: StaticMatchIndex): NormalizedBatch {
  const captured = capturedAt.toISOString();
  const operations: PendingOperation[] = [];
  const filteredEntities: unknown[] = [];
  let matchedMadridCount = 0;
  let nonMadridCount = 0;
  let unmatchedCount = 0;
  let invalidCount = 0;
  for (const invalid of feed.invalidEntities) {
    invalidCount += 1;
    if (plausibleMadrid(invalid)) operations.push(quarantine(feed, captured, invalid));
    else nonMadridCount += 1;
  }
  for (const entity of feed.entities) {
    const normalized = entity.kind === 'trip_update'
      ? normalizeTripEntity(feed, entity, captured, index)
      : entity.kind === 'vehicle_position'
        ? normalizeVehicleEntity(feed, entity, captured, index)
        : normalizeAlertEntity(feed, entity, captured, index);
    operations.push(...normalized.operations);
    if (normalized.filtered !== undefined) filteredEntities.push(normalized.filtered);
    if (normalized.disposition === 'non-madrid') nonMadridCount += 1;
    else if (normalized.disposition === 'unmatched') unmatchedCount += 1;
    else if (normalized.disposition === 'ambiguous' || normalized.invalid) invalidCount += 1;
    else matchedMadridCount += 1;
  }
  return {
    feedKind: feed.feedKind, capturedAt: captured, headerTimestamp: feed.headerTimestamp,
    operations, filteredEntities, matchedMadridCount, nonMadridCount, unmatchedCount, invalidCount,
  };
}
