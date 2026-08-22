import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCancellation,
  applyStopEvidence,
  emptyStop,
  selectJourneyProvenance,
  serviceTimeToInstant,
  type CanonicalEvidence,
} from '@atodotren/canonical-journeys';

function evidence(overrides: Partial<CanonicalEvidence> = {}): CanonicalEvidence {
  return {
    classification: 'reported_prediction', stopSequence: 1,
    capturedAt: new Date('2026-02-10T10:00:00Z'), sourceTimestamp: 1_770_717_600,
    idempotencyKey: 'a'.repeat(64), arrivalTime: null, arrivalDelay: null,
    stopRelationship: 'SCHEDULED', ...overrides,
  };
}

void test('Madrid service-day conversion preserves wall time, >24:00, midnight, and descriptor date', () => {
  assert.equal(serviceTimeToInstant('2026-02-10', 3600, 'Europe/Madrid').toISOString(), '2026-02-10T00:00:00.000Z');
  assert.equal(serviceTimeToInstant('2026-02-10', 90_000, 'Europe/Madrid').toISOString(), '2026-02-11T00:00:00.000Z');
  assert.equal(serviceTimeToInstant('2026-02-10', 86_399, 'Europe/Madrid').toISOString(), '2026-02-10T22:59:59.000Z');
  assert.notEqual(serviceTimeToInstant('2026-02-10', 3600, 'Europe/Madrid').getUTCDate(), 22);
});

void test('Madrid DST gaps move forward and folds choose the later standard-time occurrence', () => {
  assert.equal(serviceTimeToInstant('2026-03-29', 9_000, 'Europe/Madrid').toISOString(), '2026-03-29T01:30:00.000Z');
  assert.equal(serviceTimeToInstant('2026-10-25', 9_000, 'Europe/Madrid').toISOString(), '2026-10-25T01:30:00.000Z');
});

void test('arrival time wins over signed provided delay and discrepancy stays exact', () => {
  const stop = emptyStop(1, new Date('2026-02-10T10:00:00Z'));
  const counts = { stale: 0, duplicate: 0 };
  applyStopEvidence(stop, evidence({ arrivalTime: 1_770_717_540, arrivalDelay: -30 }), counts);
  assert.equal(stop.derivedDelay, -60);
  assert.equal(stop.providedDelay, -30);
  assert.equal(stop.discrepancy, 30);
  assert.equal(stop.selectedDelay, -60);
  assert.equal(stop.selectedDelaySource, 'arrival_time');
  assert.equal(stop.status, 'reported_only');
});

void test('provided delay is the fallback and stale or identical predictions are ignored', () => {
  const stop = emptyStop(1, new Date('2026-02-10T10:00:00Z'));
  const counts = { stale: 0, duplicate: 0 };
  applyStopEvidence(stop, evidence({ arrivalDelay: -45 }), counts);
  applyStopEvidence(stop, evidence({ capturedAt: new Date('2026-02-10T10:01:00Z'), sourceTimestamp: 1_770_717_660, arrivalDelay: -45 }), counts);
  applyStopEvidence(stop, evidence({ sourceTimestamp: 1_770_717_500, arrivalDelay: 90 }), counts);
  assert.equal(stop.selectedDelay, -45);
  assert.equal(stop.selectedDelaySource, 'provided_delay');
  assert.deepEqual(counts, { stale: 1, duplicate: 1 });
});

void test('presence is first-observation immutable and coexists with reported fields', () => {
  const stop = emptyStop(1, new Date('2026-02-10T10:00:00Z'));
  const counts = { stale: 0, duplicate: 0 };
  applyStopEvidence(stop, evidence({ arrivalDelay: 20 }), counts);
  applyStopEvidence(stop, evidence({ classification: 'observed_presence', sourceTimestamp: 1_770_717_620 }), counts);
  applyStopEvidence(stop, evidence({ classification: 'observed_presence', sourceTimestamp: 1_770_717_680 }), counts);
  assert.equal(stop.firstPresenceAt?.toISOString(), '2026-02-10T10:00:20.000Z');
  assert.equal(stop.selectedDelay, 20);
  assert.equal(stop.status, 'observed_presence');
});

void test('skip retains predictions while cancellation uses observed progress conservatively', () => {
  const skipped = emptyStop(1, new Date('2026-02-10T10:00:00Z'));
  const counts = { stale: 0, duplicate: 0 };
  applyStopEvidence(skipped, evidence({ arrivalDelay: 30 }), counts);
  applyStopEvidence(skipped, evidence({ classification: 'stop_skipped', stopRelationship: 'SKIPPED' }), counts);
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.selectedDelay, 30);

  const full = [1, 2, 3].map((sequence) => emptyStop(sequence, new Date()));
  assert.equal(applyCancellation(full), 'canceled');
  assert.deepEqual(full.map((stop) => stop.status), ['canceled', 'canceled', 'canceled']);

  const partial = Array.from({ length: 14 }, (_, index) => emptyStop(index + 1, new Date()));
  partial[0]!.firstPresenceAt = new Date();
  partial[0]!.status = 'observed_presence';
  partial[9]!.firstPresenceAt = new Date();
  partial[9]!.status = 'observed_presence';
  assert.equal(applyCancellation(partial), 'partially_canceled');
  assert.deepEqual(partial.slice(0, 10).map((stop) => stop.status), [
    'observed_presence', ...Array.from({ length: 8 }, () => 'missing_evidence'), 'observed_presence',
  ]);
  assert.deepEqual(partial.slice(10).map((stop) => stop.status), Array(4).fill('canceled'));
});

void test('journey provenance deterministically prefers provided dates and exact matching', () => {
  const selected = selectJourneyProvenance([
    {
      capturedAt: new Date('2026-08-22T10:00:00Z'), idempotencyKey: 'a'.repeat(64),
      startDateSource: 'inferred', matchingMethod: 'previous-unique-fallback', matchingVersion: 'matching-v1',
    },
    {
      capturedAt: new Date('2026-08-22T10:01:00Z'), idempotencyKey: 'b'.repeat(64),
      startDateSource: 'provided', matchingMethod: 'previous-exact-trip', matchingVersion: 'matching-v2',
    },
  ]);
  assert.deepEqual(selected, {
    startDateSource: 'provided', matchingMethod: 'previous-exact-trip',
    matchingVersion: 'matching-v2', matchingConfidence: 1,
  });
});
