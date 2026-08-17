import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

import type {
  AlertTargetDescriptor,
  DecodedAlert,
  DecodedEntity,
  DecodedFeed,
  DecodedTripUpdate,
  DecodedVehiclePosition,
  FeedKind,
  InvalidEntity,
  TripDescriptor,
} from './types.js';

const { transit_realtime: realtime } = GtfsRealtimeBindings;

export class FeedDecodeError extends Error {
  public readonly code: 'invalid_protobuf' | 'invalid_header' | 'differential_unsupported';

  public constructor(code: FeedDecodeError['code'], message: string) {
    super(message);
    this.name = 'FeedDecodeError';
    this.code = code;
  }
}

function has(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function optionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function integerValue(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value
    : typeof value === 'object' && 'toNumber' in value && typeof value.toNumber === 'function'
      ? (value as { toNumber(): number }).toNumber() : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function signedIntegerValue(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value
    : typeof value === 'object' && 'toNumber' in value && typeof value.toNumber === 'function'
      ? (value as { toNumber(): number }).toNumber() : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function enumName(enumObject: object, value: number | null | undefined, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  return (enumObject as Record<number, string>)[value] ?? fallback;
}

function tripDescriptor(input: GtfsRealtimeBindings.transit_realtime.ITripDescriptor): TripDescriptor {
  return {
    ...(optionalString(input.tripId) === undefined ? {} : { tripId: optionalString(input.tripId) }),
    ...(optionalString(input.routeId) === undefined ? {} : { routeId: optionalString(input.routeId) }),
    ...(optionalString(input.startDate) === undefined ? {} : { startDate: optionalString(input.startDate) }),
    ...(optionalString(input.startTime) === undefined ? {} : { startTime: optionalString(input.startTime) }),
    scheduleRelationship: enumName(
      realtime.TripDescriptor.ScheduleRelationship,
      input.scheduleRelationship,
      'SCHEDULED',
    ),
  };
}

function decodeTripUpdate(
  entityId: string,
  input: GtfsRealtimeBindings.transit_realtime.ITripUpdate,
): DecodedTripUpdate | InvalidEntity {
  if (input.trip === null || input.trip === undefined) {
    return { entityId, reasonCode: 'entity.trip_descriptor_missing', diagnosticFields: {} };
  }
  const trip = tripDescriptor(input.trip);
  if (trip.tripId === undefined && (trip.routeId === undefined || trip.startTime === undefined)) {
    return {
      entityId,
      ...(trip.routeId === undefined ? {} : { routeId: trip.routeId }),
      reasonCode: 'entity.trip_identity_insufficient',
      diagnosticFields: { hasStartDate: trip.startDate !== undefined, hasStartTime: trip.startTime !== undefined },
    };
  }
  const stopUpdates = [];
  for (const stop of input.stopTimeUpdate ?? []) {
    const stopSequence = has(stop, 'stopSequence') ? integerValue(stop.stopSequence) : undefined;
    const stopId = optionalString(stop.stopId);
    if (stopSequence === undefined && stopId === undefined) {
      return {
        entityId,
        ...(trip.tripId === undefined ? {} : { tripId: trip.tripId }),
        ...(trip.routeId === undefined ? {} : { routeId: trip.routeId }),
        reasonCode: 'entity.stop_identity_missing',
        diagnosticFields: {},
      };
    }
    const arrivalTime = stop.arrival !== null && stop.arrival !== undefined && has(stop.arrival, 'time')
      ? integerValue(stop.arrival.time) : undefined;
    const arrivalDelay = stop.arrival !== null && stop.arrival !== undefined && has(stop.arrival, 'delay')
      ? signedIntegerValue(stop.arrival.delay) : undefined;
    const relationship = enumName(
      realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship,
      stop.scheduleRelationship,
      'SCHEDULED',
    );
    stopUpdates.push({
      ...(stopSequence === undefined ? {} : { stopSequence }),
      ...(stopId === undefined ? {} : { stopId }),
      ...(arrivalTime === undefined ? {} : { arrivalTime }),
      ...(arrivalDelay === undefined ? {} : { arrivalDelay }),
      relationship,
    });
  }
  return {
    kind: 'trip_update',
    entityId,
    trip,
    ...(has(input, 'timestamp') && integerValue(input.timestamp) !== undefined
      ? { timestamp: integerValue(input.timestamp) }
      : {}),
    stopUpdates,
  };
}

function decodeVehicle(
  entityId: string,
  input: GtfsRealtimeBindings.transit_realtime.IVehiclePosition,
): DecodedVehiclePosition | InvalidEntity {
  if (input.trip === null || input.trip === undefined) {
    return { entityId, reasonCode: 'entity.trip_descriptor_missing', diagnosticFields: {} };
  }
  const trip = tripDescriptor(input.trip);
  if (trip.tripId === undefined && (trip.routeId === undefined || trip.startTime === undefined)) {
    return {
      entityId,
      ...(trip.routeId === undefined ? {} : { routeId: trip.routeId }),
      reasonCode: 'entity.trip_identity_insufficient',
      diagnosticFields: { hasStartDate: trip.startDate !== undefined, hasStartTime: trip.startTime !== undefined },
    };
  }
  const latitude = input.position?.latitude;
  const longitude = input.position?.longitude;
  if ((latitude === undefined || latitude === null) !== (longitude === undefined || longitude === null)) {
    return {
      entityId,
      ...(trip.tripId === undefined ? {} : { tripId: trip.tripId }),
      reasonCode: 'entity.position_incomplete',
      diagnosticFields: {},
    };
  }
  return {
    kind: 'vehicle_position',
    entityId,
    trip,
    ...(optionalString(input.vehicle?.id) === undefined ? {} : { vehicleId: optionalString(input.vehicle?.id) }),
    ...(has(input, 'timestamp') && integerValue(input.timestamp) !== undefined
      ? { timestamp: integerValue(input.timestamp) }
      : {}),
    ...(latitude === undefined || latitude === null ? {} : { latitude }),
    ...(longitude === undefined || longitude === null ? {} : { longitude }),
    ...(input.position?.bearing === undefined || input.position.bearing === null ? {} : { bearing: input.position.bearing }),
    ...(input.position?.speed === undefined || input.position.speed === null ? {} : { speed: input.position.speed }),
    ...(has(input, 'currentStopSequence') && integerValue(input.currentStopSequence) !== undefined
      ? { currentStopSequence: integerValue(input.currentStopSequence) }
      : {}),
    ...(optionalString(input.stopId) === undefined ? {} : { stopId: optionalString(input.stopId) }),
    currentStatus: enumName(realtime.VehiclePosition.VehicleStopStatus, input.currentStatus, 'IN_TRANSIT_TO'),
  };
}

function translatedText(input: GtfsRealtimeBindings.transit_realtime.ITranslatedString | null | undefined): string {
  const translations = input?.translation ?? [];
  const preferred = translations.find((item) => /^es(?:-|$)/iu.test(item.language ?? '')) ?? translations[0];
  return preferred?.text?.trim() ?? '';
}

function decodeAlert(
  entityId: string,
  input: GtfsRealtimeBindings.transit_realtime.IAlert,
): DecodedAlert | InvalidEntity {
  const headerText = translatedText(input.headerText);
  const descriptionText = translatedText(input.descriptionText);
  if (headerText === '' && descriptionText === '') {
    return { entityId, reasonCode: 'entity.alert_text_missing', diagnosticFields: {} };
  }
  const targets: AlertTargetDescriptor[] = (input.informedEntity ?? []).map((target) => ({
    ...(optionalString(target.routeId) === undefined ? {} : { routeId: optionalString(target.routeId) }),
    ...(optionalString(target.stopId) === undefined ? {} : { stopId: optionalString(target.stopId) }),
    ...(target.trip === null || target.trip === undefined ? {} : { trip: tripDescriptor(target.trip) }),
  }));
  return {
    kind: 'alert',
    entityId,
    activePeriods: (input.activePeriod ?? []).map((period) => ({
      ...(has(period, 'start') && integerValue(period.start) !== undefined ? { start: integerValue(period.start) } : {}),
      ...(has(period, 'end') && integerValue(period.end) !== undefined ? { end: integerValue(period.end) } : {}),
    })),
    targets,
    cause: enumName(realtime.Alert.Cause, input.cause, 'UNKNOWN_CAUSE'),
    effect: enumName(realtime.Alert.Effect, input.effect, 'UNKNOWN_EFFECT'),
    headerText,
    descriptionText,
    ...(translatedText(input.url) === '' ? {} : { url: translatedText(input.url) }),
  };
}

export function decodeFeed(buffer: Uint8Array, feedKind: FeedKind): DecodedFeed {
  let feed: GtfsRealtimeBindings.transit_realtime.FeedMessage;
  try {
    feed = realtime.FeedMessage.decode(buffer);
  } catch (error) {
    throw new FeedDecodeError('invalid_protobuf', error instanceof Error ? error.message : 'Unreadable protobuf');
  }
  const version = feed.header?.gtfsRealtimeVersion?.trim();
  const timestamp = feed.header !== undefined && has(feed.header, 'timestamp')
    ? integerValue(feed.header.timestamp) : undefined;
  if (version === undefined || version === '' || timestamp === undefined) {
    throw new FeedDecodeError('invalid_header', 'GTFS-Realtime header requires version and timestamp');
  }
  if (feed.header.incrementality === realtime.FeedHeader.Incrementality.DIFFERENTIAL) {
    throw new FeedDecodeError('differential_unsupported', 'DIFFERENTIAL feeds are not accepted as snapshots');
  }

  const entities: DecodedEntity[] = [];
  const invalidEntities: InvalidEntity[] = [];
  for (const entity of feed.entity) {
    const entityId = optionalString(entity.id);
    const payloads = [entity.tripUpdate, entity.vehicle, entity.alert, entity.shape, entity.stop, entity.tripModifications]
      .filter((value) => value !== null && value !== undefined).length;
    if (entityId === undefined || entity.isDeleted || payloads !== 1) {
      invalidEntities.push({
        ...(entityId === undefined ? {} : { entityId }),
        reasonCode: entity.isDeleted ? 'entity.deleted_in_full_dataset' : 'entity.payload_cardinality',
        diagnosticFields: { payloadCount: payloads },
      });
      continue;
    }
    let decoded: DecodedEntity | InvalidEntity;
    if (feedKind === 'trip_updates' && entity.tripUpdate !== null && entity.tripUpdate !== undefined) {
      decoded = decodeTripUpdate(entityId, entity.tripUpdate);
    } else if (feedKind === 'vehicle_positions' && entity.vehicle !== null && entity.vehicle !== undefined) {
      decoded = decodeVehicle(entityId, entity.vehicle);
    } else if (feedKind === 'service_alerts' && entity.alert !== null && entity.alert !== undefined) {
      decoded = decodeAlert(entityId, entity.alert);
    } else {
      decoded = { entityId, reasonCode: 'entity.unexpected_payload', diagnosticFields: { feedKind } };
    }
    if ('reasonCode' in decoded) invalidEntities.push(decoded);
    else entities.push(decoded);
  }
  return { feedKind, headerTimestamp: timestamp, entities, invalidEntities, entityTotal: feed.entity.length };
}

export const protobufTypes = realtime;
