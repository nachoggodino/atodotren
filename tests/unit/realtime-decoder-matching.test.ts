import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeFeed,
  FeedDecodeError,
  matchTrip,
  parseGtfsTime,
  resolveStop,
  type StaticMatchIndex,
  type StaticTripCandidate,
} from '@atodotren/gtfs-realtime';

import { activeTrip, encodeRealtime, previousTrip, staticIndex } from '../helpers/realtime.js';

void test('decodes official protobuf semantics while preserving signed arrivals and independent malformed entities', () => {
  const body = encodeRealtime([
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
  assert.throws(() => decodeFeed(encodeRealtime([], { gtfsRealtimeVersion: '2.0' }), 'trip_updates'),
    (error: unknown) => error instanceof FeedDecodeError && error.code === 'invalid_header');
  assert.throws(() => decodeFeed(encodeRealtime([], {
    gtfsRealtimeVersion: '2.0', timestamp: 1_725_000_000, incrementality: 1,
  }), 'trip_updates'),
  (error: unknown) => error instanceof FeedDecodeError && error.code === 'differential_unsupported');
});

void test('matches active exact, previous exact, unique fallback, ambiguity, missing descriptors, and >24:00 times', () => {
  assert.equal(matchTrip(staticIndex, { tripId: '10T1', scheduleRelationship: 'SCHEDULED' }).disposition, 'active-exact-trip');
  assert.equal(matchTrip(staticIndex, { tripId: '10OLD', scheduleRelationship: 'SCHEDULED' }).disposition, 'previous-exact-trip');
  assert.equal(matchTrip(staticIndex, {
    routeId: '10R1', startTime: '25:15:00', startDate: '20260817', scheduleRelationship: 'SCHEDULED',
  }).disposition, 'active-unique-fallback');
  assert.equal(parseGtfsTime('25:15:00'), 90_900);
  assert.equal(matchTrip(staticIndex, { scheduleRelationship: 'SCHEDULED' }).disposition, 'unmatched');
  assert.equal(matchTrip(staticIndex, { routeId: '20NATIONAL', scheduleRelationship: 'SCHEDULED' }).disposition, 'non-madrid');
  const ambiguous: StaticMatchIndex = { candidates: [activeTrip, { ...activeTrip, tripId: '10T2' }] };
  assert.equal(matchTrip(ambiguous, {
    routeId: '10R1', startTime: '25:15:00', scheduleRelationship: 'SCHEDULED',
  }).disposition, 'ambiguous');
});

void test('rollover matching chooses the archive whose calendar date fits the realtime timestamp', () => {
  const tripId = '10ROLLOVER';
  const activeRollover: StaticTripCandidate = {
    ...activeTrip,
    feedVersionId: '11',
    versionPosition: 'active',
    tripId,
    serviceDates: new Set(['2026-08-18']),
  };
  const previousRollover: StaticTripCandidate = {
    ...activeTrip,
    feedVersionId: '10',
    versionPosition: 'previous',
    tripId,
    serviceDates: new Set(['2026-08-17']),
  };
  const arrivalTime = Math.floor(Date.parse('2026-08-17T23:00:30Z') / 1000);
  const result = matchTrip(
    { candidates: [activeRollover, previousRollover] },
    { tripId, scheduleRelationship: 'SCHEDULED' },
    [{ stopSequence: 1, stopId: 'A', arrivalTime }],
    { fallbackInstantSeconds: arrivalTime },
  );
  assert.equal(result.disposition, 'previous-exact-trip');
  assert.equal(result.candidate?.feedVersionId, '10');
  assert.equal(result.inferredServiceDate, '2026-08-17');
});

void test('exact matching evaluates temporal evidence only for identity candidates', () => {
  const irrelevant = Array.from({ length: 5_000 }, (_, candidateIndex): StaticTripCandidate => ({
    ...activeTrip,
    tripId: `10IRRELEVANT${candidateIndex}`,
    routeId: `10R${candidateIndex % 50}`,
  }));
  let evaluated = 0;
  const arrivalTime = Math.floor(Date.parse('2026-08-17T23:00:30Z') / 1000);
  const result = matchTrip(
    { candidates: [...irrelevant, activeTrip, previousTrip] },
    { tripId: activeTrip.tripId, scheduleRelationship: 'SCHEDULED' },
    [{ stopSequence: 1, stopId: 'A', arrivalTime }],
    { fallbackInstantSeconds: arrivalTime, onTemporalCandidate: () => { evaluated += 1; } },
  );
  assert.equal(result.disposition, 'active-exact-trip');
  assert.equal(evaluated, 1);
});

void test('stop_sequence disambiguates repeated stops and stop_id alone is rejected as ambiguous', () => {
  assert.equal(resolveStop(activeTrip, { stopSequence: 3, stopId: 'A' }).stop?.stopSequence, 3);
  assert.deepEqual(resolveStop(activeTrip, { stopId: 'A' }), { ambiguous: true });
});
