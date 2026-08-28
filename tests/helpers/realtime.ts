import {
  protobufTypes,
  type PollRecord,
  type StaticMatchIndex,
  type StaticTripCandidate,
} from '@atodotren/gtfs-realtime';

export function encodeRealtime(
  entity: readonly object[],
  header: object = { gtfsRealtimeVersion: '2.0', timestamp: 1_725_000_000 },
): Uint8Array {
  return protobufTypes.FeedMessage.encode({ header: header as never, entity: [...entity] as never }).finish();
}

export const activeTrip: StaticTripCandidate = {
  feedVersionId: '10', versionPosition: 'active', tripId: '10T1', routeId: '10R1',
  serviceId: 'daily', firstTimeSeconds: 25 * 3600 + 15 * 60, lineId: '1', branchId: '2',
  servicePatternId: '3', shapeId: 'shape-1', serviceDates: new Set(['2026-08-17']),
  stops: [
    { stopSequence: 1, stopId: 'A', stationId: '100', arrivalSeconds: 90_000 },
    { stopSequence: 2, stopId: 'B', stationId: '101', arrivalSeconds: 90_600 },
    { stopSequence: 3, stopId: 'A', stationId: '100', arrivalSeconds: 91_200 },
  ],
};

export const previousTrip: StaticTripCandidate = {
  ...activeTrip, feedVersionId: '9', versionPosition: 'previous', tripId: '10OLD',
};

export const staticIndex: StaticMatchIndex = { candidates: [activeTrip, previousTrip] };

export function realtimePoll(id: string): PollRecord {
  return {
    idempotencyKey: id.padEnd(64, '0'), feedKind: 'vehicle_positions',
    startedAt: '2099-08-17T10:00:00.000Z', completedAt: '2099-08-17T10:00:01.000Z',
    capturedAt: '2099-08-17T10:00:01.000Z', feedHeaderTimestamp: 1_725_000_000,
    httpStatus: 200, resultClass: 'success', responseBytes: 100, entityTotal: 1,
    matchedMadridCount: 1, nonMadridCount: 0, unmatchedCount: 0, invalidCount: 0,
    responseDurationMs: 10, persistenceDurationMs: 0,
  };
}
