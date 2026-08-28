import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquireFeed,
  decodeFeed,
  FeedAcquisitionError,
  normalizeFeed,
} from '@atodotren/gtfs-realtime';

import { encodeRealtime, staticIndex } from '../helpers/realtime.js';

void test('normalization separates cancellation, skipped, predictions and STOPPED_AT presence without departures', () => {
  const tripFeed = decodeFeed(encodeRealtime([{
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
  const batch = normalizeFeed(tripFeed, new Date('2026-08-17T10:00:00Z'), staticIndex);
  const evidence = batch.operations.filter((operation) => operation.kind === 'stop_evidence');
  assert.deepEqual(evidence.map((item) => item.classification), [
    'trip_cancellation', 'reported_prediction', 'stop_skipped',
  ]);
  assert.equal(evidence[1]?.arrivalDelay, 121);

  const vehicleFeed = decodeFeed(encodeRealtime([{
    id: 'vp-entity', vehicle: {
      trip: { tripId: '10T1', startDate: '20260817' }, vehicle: { id: 'vehicle-7' },
      timestamp: 1_725_000_050, currentStatus: 1, currentStopSequence: 2, stopId: 'B',
      position: { latitude: 40.4, longitude: -3.7, speed: 0 },
    },
  }]), 'vehicle_positions');
  const vehicleBatch = normalizeFeed(vehicleFeed, new Date('2026-08-17T10:00:30Z'), staticIndex);
  const presence = vehicleBatch.operations.find((operation) => operation.kind === 'stop_evidence');
  assert.equal(presence?.kind, 'stop_evidence');
  if (presence?.kind === 'stop_evidence') {
    assert.equal(presence.classification, 'observed_presence');
    assert.equal(presence.sourceTimestamp, 1_725_000_050);
    assert.equal(presence.arrivalTime, undefined);
  }
});

void test('normalization infers an omitted RENFE service date from absolute stop timestamps', () => {
  const arrivalTime = Math.floor(Date.parse('2026-08-17T23:00:30Z') / 1000);
  const tripFeed = decodeFeed(encodeRealtime([{
    id: 'tu-inferred', tripUpdate: {
      trip: { tripId: '10T1' }, timestamp: arrivalTime - 60,
      stopTimeUpdate: [{ stopSequence: 1, stopId: 'A', arrival: { time: arrivalTime, delay: 30 } }],
    },
  }]), 'trip_updates');
  const tripBatch = normalizeFeed(tripFeed, new Date('2026-08-17T22:59:30Z'), staticIndex);
  const prediction = tripBatch.operations.find((operation) => operation.kind === 'stop_evidence');
  assert.equal(prediction?.kind, 'stop_evidence');
  if (prediction?.kind === 'stop_evidence') {
    assert.equal(prediction.serviceDate, '2026-08-17');
    assert.equal(prediction.startDateSource, 'inferred');
    assert.match(prediction.evidenceKey, /:2026-08-17:/u);
  }

  const vehicleFeed = decodeFeed(encodeRealtime([{
    id: 'vp-inferred', vehicle: {
      trip: { tripId: '10T1' }, vehicle: { id: 'vehicle-inferred' },
      timestamp: arrivalTime, currentStatus: 1, currentStopSequence: 1, stopId: 'A',
    },
  }]), 'vehicle_positions');
  const vehicleBatch = normalizeFeed(vehicleFeed, new Date('2026-08-17T23:00:31Z'), staticIndex);
  const vehicle = vehicleBatch.operations.find((operation) => operation.kind === 'vehicle_state');
  assert.equal(vehicle?.kind, 'vehicle_state');
  if (vehicle?.kind === 'vehicle_state') assert.equal(vehicle.serviceDate, '2026-08-17');
  const presence = vehicleBatch.operations.find((operation) => operation.kind === 'stop_evidence');
  assert.equal(presence?.kind, 'stop_evidence');
  if (presence?.kind === 'stop_evidence') assert.equal(presence.startDateSource, 'inferred');
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

void test('bounded acquisition rejects oversized responses', async () => {
  await assert.rejects(acquireFeed({ kind: 'trip_updates', url: 'http://localhost/feed', enabled: true }, {
    timeoutMs: 1_000, maxResponseBytes: 2,
    fetchImplementation: () => Promise.resolve(new Response(Uint8Array.from([1, 2, 3]), {
      status: 200, headers: { 'content-length': '3' },
    })),
    sleep: () => Promise.resolve(),
  }), (error: unknown) => error instanceof FeedAcquisitionError && error.code === 'response_too_large');
});
