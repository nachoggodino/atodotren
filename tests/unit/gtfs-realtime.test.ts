import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  acquireFeed,
  decodeFeed,
  FeedAcquisitionError,
  FeedDecodeError,
  matchTrip,
  normalizeFeed,
  OutageSpool,
  parseGtfsTime,
  protobufTypes,
  resolveStop,
  sendOperationalAlert,
  type NormalizedBatch,
  type PollRecord,
  type StaticMatchIndex,
  type StaticTripCandidate,
} from '@atodotren/gtfs-realtime';

function encode(entity: readonly object[], header: object = { gtfsRealtimeVersion: '2.0', timestamp: 1_725_000_000 }): Uint8Array {
  return protobufTypes.FeedMessage.encode({ header: header as never, entity: [...entity] as never }).finish();
}

const activeTrip: StaticTripCandidate = {
  feedVersionId: '10', versionPosition: 'active', tripId: '10T1', routeId: '10R1',
  serviceId: 'daily', firstTimeSeconds: 25 * 3600 + 15 * 60, lineId: '1', branchId: '2',
  servicePatternId: '3', shapeId: 'shape-1', serviceDates: new Set(['2026-08-17']),
  stops: [
    { stopSequence: 1, stopId: 'A', stationId: '100', arrivalSeconds: 90_000 },
    { stopSequence: 2, stopId: 'B', stationId: '101', arrivalSeconds: 90_600 },
    { stopSequence: 3, stopId: 'A', stationId: '100', arrivalSeconds: 91_200 },
  ],
};
const previousTrip: StaticTripCandidate = {
  ...activeTrip, feedVersionId: '9', versionPosition: 'previous', tripId: '10OLD',
};
const index: StaticMatchIndex = { candidates: [activeTrip, previousTrip] };

void test('decodes official protobuf semantics while preserving signed arrivals and independent malformed entities', () => {
  const body = encode([
    {
      id: 'feed-entity-1',
      tripUpdate: {
        trip: { tripId: '10T1', routeId: '10R1', startDate: '20260817', startTime: '25:15:00' },
        timestamp: 1_725_000_001,
        stopTimeUpdate: [
          { stopSequence: 1, stopId: 'A', arrival: { time: 1_725_000_120, delay: -30 } },
          { stopSequence: 2, stopId: 'B', scheduleRelationship: 1 },
          { stopSequence: 3, stopId: 'A', departure: { delay: 15 } },
        ],
      },
    },
    { id: 'wrong-payload', vehicle: { trip: { tripId: '10T1' } } },
  ]);
  const feed = decodeFeed(body, 'trip_updates');
  assert.equal(feed.headerTimestamp, 1_725_000_000);
  assert.equal(feed.entityTotal, 2);
  assert.equal(feed.entities.length, 1);
  assert.equal(feed.invalidEntities[0]?.reasonCode, 'entity.unexpected_payload');
  const trip = feed.entities[0];
  assert.equal(trip?.kind, 'trip_update');
  if (trip?.kind !== 'trip_update') return;
  assert.notEqual(trip.entityId, trip.trip.tripId);
  assert.deepEqual(trip.stopUpdates[0], {
    stopSequence: 1, stopId: 'A', arrivalTime: 1_725_000_120,
    arrivalDelay: -30, relationship: 'SCHEDULED',
  });
  assert.equal(trip.stopUpdates[1]?.relationship, 'SKIPPED');
  assert.equal(trip.stopUpdates[2]?.arrivalTime, undefined);
  assert.equal(trip.stopUpdates[2]?.arrivalDelay, undefined);
});

void test('rejects unusable framing, unusable headers, and DIFFERENTIAL snapshots at feed level', () => {
  assert.throws(() => decodeFeed(Uint8Array.from([255, 255]), 'trip_updates'), FeedDecodeError);
  assert.throws(() => decodeFeed(encode([], { gtfsRealtimeVersion: '2.0' }), 'trip_updates'),
    (error: unknown) => error instanceof FeedDecodeError && error.code === 'invalid_header');
  assert.throws(() => decodeFeed(encode([], {
    gtfsRealtimeVersion: '2.0', timestamp: 1_725_000_000, incrementality: 1,
  }), 'trip_updates'),
  (error: unknown) => error instanceof FeedDecodeError && error.code === 'differential_unsupported');
});

void test('matches active exact, previous exact, unique fallback, ambiguity, missing descriptors, and >24:00 times', () => {
  assert.equal(matchTrip(index, { tripId: '10T1', scheduleRelationship: 'SCHEDULED' }).disposition, 'active-exact-trip');
  assert.equal(matchTrip(index, { tripId: '10OLD', scheduleRelationship: 'SCHEDULED' }).disposition, 'previous-exact-trip');
  assert.equal(matchTrip(index, {
    routeId: '10R1', startTime: '25:15:00', startDate: '20260817', scheduleRelationship: 'SCHEDULED',
  }).disposition, 'active-unique-fallback');
  assert.equal(parseGtfsTime('25:15:00'), 90_900);
  assert.equal(matchTrip(index, { scheduleRelationship: 'SCHEDULED' }).disposition, 'unmatched');
  assert.equal(matchTrip(index, { routeId: '20NATIONAL', scheduleRelationship: 'SCHEDULED' }).disposition, 'non-madrid');
  const ambiguous: StaticMatchIndex = { candidates: [activeTrip, { ...activeTrip, tripId: '10T2' }] };
  assert.equal(matchTrip(ambiguous, {
    routeId: '10R1', startTime: '25:15:00', scheduleRelationship: 'SCHEDULED',
  }).disposition, 'ambiguous');
});

void test('stop_sequence disambiguates repeated stops and stop_id alone is rejected as ambiguous', () => {
  assert.equal(resolveStop(activeTrip, { stopSequence: 3, stopId: 'A' }).stop?.stopSequence, 3);
  assert.deepEqual(resolveStop(activeTrip, { stopId: 'A' }), { ambiguous: true });
});

void test('normalization separates cancellation, skipped, predictions and STOPPED_AT presence without departures', () => {
  const tripFeed = decodeFeed(encode([{
    id: 'tu-1', tripUpdate: {
      trip: { tripId: '10T1', startDate: '20260817', scheduleRelationship: 3 },
      timestamp: 1_725_000_001,
      stopTimeUpdate: [
        { stopSequence: 1, arrival: { delay: 121 } },
        { stopSequence: 2, scheduleRelationship: 1 },
        { stopSequence: 3, departure: { delay: 500 } },
      ],
    },
  }]), 'trip_updates');
  const batch = normalizeFeed(tripFeed, new Date('2026-08-17T10:00:00Z'), index);
  const evidence = batch.operations.filter((operation) => operation.kind === 'stop_evidence');
  assert.deepEqual(evidence.map((item) => item.classification), [
    'trip_cancellation', 'reported_prediction', 'stop_skipped',
  ]);
  assert.equal(evidence[1]?.arrivalDelay, 121);

  const vehicleFeed = decodeFeed(encode([{
    id: 'vp-entity', vehicle: {
      trip: { tripId: '10T1', startDate: '20260817' }, vehicle: { id: 'vehicle-7' },
      timestamp: 1_725_000_050, currentStatus: 1, currentStopSequence: 2, stopId: 'B',
      position: { latitude: 40.4, longitude: -3.7, speed: 0 },
    },
  }]), 'vehicle_positions');
  const vehicleBatch = normalizeFeed(vehicleFeed, new Date('2026-08-17T10:00:30Z'), index);
  const presence = vehicleBatch.operations.find((operation) => operation.kind === 'stop_evidence');
  assert.equal(presence?.kind, 'stop_evidence');
  if (presence?.kind === 'stop_evidence') {
    assert.equal(presence.classification, 'observed_presence');
    assert.equal(presence.sourceTimestamp, 1_725_000_050);
    assert.equal(presence.arrivalTime, undefined);
  }
});

void test('bounded acquisition does not retry 4xx and retries one transient 5xx', async () => {
  let calls = 0;
  await assert.rejects(acquireFeed({ kind: 'trip_updates', url: 'http://localhost/feed', enabled: true }, {
    timeoutMs: 1_000, maxResponseBytes: 1_024,
    fetchImplementation: () => { calls += 1; return Promise.resolve(new Response('', { status: 404 })); },
    sleep: () => Promise.resolve(),
  }), (error: unknown) => error instanceof FeedAcquisitionError && error.code === 'http_4xx');
  assert.equal(calls, 1);
  calls = 0;
  const result = await acquireFeed({ kind: 'trip_updates', url: 'http://localhost/feed', enabled: true }, {
    timeoutMs: 1_000, maxResponseBytes: 1_024,
    fetchImplementation: () => {
      calls += 1;
      return Promise.resolve(calls === 1
        ? new Response('', { status: 503 })
        : new Response(Uint8Array.from([1, 2, 3]), { status: 200 }));
    },
    sleep: () => Promise.resolve(), random: () => 0,
  });
  assert.equal(result.attempts, 2);
  assert.equal(result.responseBytes, 3);
});

void test('bounded acquisition rejects oversized responses and alert transports stay injectable', async () => {
  await assert.rejects(acquireFeed({ kind: 'trip_updates', url: 'http://localhost/feed', enabled: true }, {
    timeoutMs: 1_000, maxResponseBytes: 2,
    fetchImplementation: () => Promise.resolve(new Response(Uint8Array.from([1, 2, 3]), {
      status: 200, headers: { 'content-length': '3' },
    })),
    sleep: () => Promise.resolve(),
  }), (error: unknown) => error instanceof FeedAcquisitionError && error.code === 'response_too_large');

  const deliveries: string[] = [];
  await sendOperationalAlert([
    { name: 'fake-telegram', send: () => { deliveries.push('telegram'); return Promise.resolve(); } },
    { name: 'fake-smtp', send: () => { deliveries.push('smtp'); return Promise.resolve(); } },
  ], { incidentKey: 'test', title: 'Test alert', body: 'Offline transport test', recovery: false });
  assert.deepEqual(deliveries.sort(), ['smtp', 'telegram']);
});

function poll(id: string): PollRecord {
  return {
    idempotencyKey: id.padEnd(64, '0'), feedKind: 'vehicle_positions',
    startedAt: '2026-08-17T10:00:00.000Z', completedAt: '2026-08-17T10:00:01.000Z',
    capturedAt: '2026-08-17T10:00:01.000Z', feedHeaderTimestamp: 1_725_000_000,
    httpStatus: 200, resultClass: 'success', responseBytes: 100, entityTotal: 1,
    matchedMadridCount: 1, nonMadridCount: 0, unmatchedCount: 0, invalidCount: 0,
    responseDurationMs: 10, persistenceDurationMs: 0,
  };
}

void test('SQLite spool is restart-safe, duplicate-safe, bounded, and sheds vehicle state first', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atodotren-spool-'));
  const path = join(directory, 'spool.sqlite');
  try {
    const spool = new OutageSpool(path, 2_000_000);
    const batch: NormalizedBatch = {
      feedKind: 'vehicle_positions', capturedAt: '2026-08-17T10:00:01.000Z',
      headerTimestamp: 1_725_000_000, matchedMadridCount: 1, nonMadridCount: 0,
      unmatchedCount: 0, invalidCount: 0, filteredEntities: [],
      operations: [{
        kind: 'vehicle_state', idempotencyKey: 'a'.repeat(64), stateKey: 'state',
        capturedAt: '2026-08-17T10:00:01.000Z', feedVersionId: '10', sourceTripId: '10T1',
        lineId: '1', branchId: '2', servicePatternId: '3', entityId: 'x'.repeat(1_350_000),
        currentStatus: 'IN_TRANSIT_TO', feedHeaderTimestamp: 1_725_000_000,
        projectionInput: 'none', contentChecksum: 'b'.repeat(64),
      }],
    };
    const stored = spool.enqueue({ poll: poll('1'), batch });
    assert.equal(stored.stored, true);
    assert.equal(stored.droppedVehiclePositions, 0);
    assert.equal(spool.enqueue({ poll: poll('1'), batch }).duplicate, true);
    const important: NormalizedBatch = {
      ...batch,
      feedKind: 'service_alerts',
      operations: [{
        kind: 'service_alert', idempotencyKey: 'c'.repeat(64), sourceAlertId: 'alert',
        feedHeaderTimestamp: 1_725_000_000, capturedAt: '2026-08-17T10:00:02.000Z',
        activePeriods: [], cause: 'UNKNOWN_CAUSE', effect: 'UNKNOWN_EFFECT',
        headerText: 'important'.repeat(80_000), descriptionText: '',
        contentChecksum: 'd'.repeat(64),
        targets: [{ order: 0, feedVersionId: '10', routeId: '10R1' }],
      }],
    };
    const priorityStored = spool.enqueue({ poll: poll('2'), batch: important });
    assert.equal(priorityStored.stored, true);
    assert.equal(priorityStored.droppedVehiclePositions, 1);
    assert.ok(spool.sizeBytes() <= spool.capacityBytes);
    spool.close();
    const reopened = new OutageSpool(path, 2_000_000);
    assert.equal(reopened.stats().pendingCount, 1);
    assert.equal(reopened.stats().droppedByReason.capacity_vehicle_shed, 1);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
