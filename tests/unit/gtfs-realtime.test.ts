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
  IncidentTracker,
  matchTrip,
  mergeStaticMatchIndex,
  normalizeFeed,
  OutageSpool,
  parseGtfsTime,
  PostgresIncidentStore,
  protobufTypes,
  resolveStop,
  RetryingAlertDelivery,
  runIngest,
  sendOperationalAlert,
  type NormalizedBatch,
  type PollRecord,
  type IncidentRecord,
  type IncidentStore,
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

void test('exact matching evaluates time only for identity candidates despite a large accumulated cache', () => {
  const irrelevant = Array.from({ length: 5_000 }, (_, candidateIndex): StaticTripCandidate => ({
    ...activeTrip,
    tripId: `10IRRELEVANT${candidateIndex}`,
    routeId: `10R${candidateIndex % 50}`,
  }));
  let evaluated = 0;
  const arrivalTime = Math.floor(Date.parse('2026-08-17T23:00:30Z') / 1000);
  const started = performance.now();
  const result = matchTrip(
    { candidates: [...irrelevant, activeTrip, previousTrip] },
    { tripId: activeTrip.tripId, scheduleRelationship: 'SCHEDULED' },
    [{ stopSequence: 1, stopId: 'A', arrivalTime }],
    { fallbackInstantSeconds: arrivalTime, onTemporalCandidate: () => { evaluated += 1; } },
  );
  assert.equal(result.disposition, 'active-exact-trip');
  assert.equal(evaluated, 1);
  assert.ok(performance.now() - started < 2_000);
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

void test('normalization infers an omitted RENFE service date from absolute stop timestamps', () => {
  const arrivalTime = Math.floor(Date.parse('2026-08-17T23:00:30Z') / 1000);
  const tripFeed = decodeFeed(encode([{
    id: 'tu-inferred', tripUpdate: {
      trip: { tripId: '10T1' }, timestamp: arrivalTime - 60,
      stopTimeUpdate: [{ stopSequence: 1, stopId: 'A', arrival: { time: arrivalTime, delay: 30 } }],
    },
  }]), 'trip_updates');
  const tripBatch = normalizeFeed(tripFeed, new Date('2026-08-17T22:59:30Z'), index);
  const prediction = tripBatch.operations.find((operation) => operation.kind === 'stop_evidence');
  assert.equal(prediction?.kind, 'stop_evidence');
  if (prediction?.kind === 'stop_evidence') {
    assert.equal(prediction.serviceDate, '2026-08-17');
    assert.equal(prediction.startDateSource, 'inferred');
    assert.match(prediction.evidenceKey, /:2026-08-17:/u);
  }

  const vehicleFeed = decodeFeed(encode([{
    id: 'vp-inferred', vehicle: {
      trip: { tripId: '10T1' }, vehicle: { id: 'vehicle-inferred' },
      timestamp: arrivalTime, currentStatus: 1, currentStopSequence: 1, stopId: 'A',
    },
  }]), 'vehicle_positions');
  const vehicleBatch = normalizeFeed(vehicleFeed, new Date('2026-08-17T23:00:31Z'), index);
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

void test('partial alert delivery retries only failed transports and recovery remains deliverable', async () => {
  let telegramCalls = 0;
  let smtpCalls = 0;
  const delivery = new RetryingAlertDelivery([
    { name: 'telegram', send: () => { telegramCalls += 1; return Promise.resolve(); } },
    { name: 'smtp', send: () => {
      smtpCalls += 1;
      return smtpCalls === 1 ? Promise.reject(new Error('temporary SMTP failure')) : Promise.resolve();
    } },
  ]);
  const incident = { incidentKey: 'test.partial', title: 'Partial', body: 'test', recovery: false };
  await assert.rejects(delivery.send(incident), AggregateError);
  await delivery.send(incident);
  assert.deepEqual({ telegramCalls, smtpCalls }, { telegramCalls: 1, smtpCalls: 2 });
  await delivery.send({ ...incident, recovery: true });
  assert.deepEqual({ telegramCalls, smtpCalls }, { telegramCalls: 2, smtpCalls: 3 });
});

class MemoryIncidentStore implements IncidentStore {
  readonly records = new Map<string, IncidentRecord>();
  failRead = false;
  failSave = false;
  failMark = false;
  failClose = false;
  zeroSave = false;
  zeroMark = false;
  zeroClose = false;

  public read(incidentKey: string): Promise<IncidentRecord | undefined> {
    if (this.failRead) return Promise.reject(Object.assign(new Error('hidden connection detail'), { code: 'XX001' }));
    return Promise.resolve(this.records.get(incidentKey));
  }

  public saveOpen(options: { readonly incidentKey: string; readonly occurrenceCount: number }): Promise<boolean> {
    if (this.failSave) return Promise.reject(Object.assign(new Error('hidden connection detail'), { code: '08006' }));
    if (this.zeroSave) return Promise.resolve(false);
    const existing = this.records.get(options.incidentKey);
    this.records.set(options.incidentKey, {
      openedAt: existing?.isOpen === true ? existing.openedAt : new Date('2026-08-22T10:00:00Z'),
      occurrenceCount: options.occurrenceCount,
      isOpen: true,
      lastNotifiedAt: existing?.isOpen === true ? existing.lastNotifiedAt : null,
    });
    return Promise.resolve(true);
  }

  public markNotified(incidentKey: string): Promise<boolean> {
    if (this.failMark) return Promise.reject(new Error('hidden connection detail'));
    if (this.zeroMark) return Promise.resolve(false);
    const existing = this.records.get(incidentKey);
    if (existing === undefined || !existing.isOpen) return Promise.resolve(false);
    this.records.set(incidentKey, { ...existing, lastNotifiedAt: new Date('2026-08-22T10:01:00Z') });
    return Promise.resolve(true);
  }

  public close(incidentKey: string): Promise<boolean> {
    if (this.failClose) return Promise.reject(new Error('hidden connection detail'));
    if (this.zeroClose) return Promise.resolve(false);
    const existing = this.records.get(incidentKey);
    if (existing === undefined || !existing.isOpen) return Promise.resolve(false);
    this.records.set(incidentKey, { ...existing, isOpen: false });
    return Promise.resolve(true);
  }
}

function incidentHarness(store = new MemoryIncidentStore()): {
  readonly store: MemoryIncidentStore;
  readonly deliveries: boolean[];
  readonly tracker: IncidentTracker;
  readonly observe: (active: boolean) => Promise<string>;
} {
  const deliveries: boolean[] = [];
  const tracker = new IncidentTracker({
    store,
    transports: [{
      name: 'fake',
      send: (message) => { deliveries.push(message.recovery); return Promise.resolve(); },
    }],
    now: () => new Date('2026-08-22T10:00:00Z'),
  });
  return {
    store, deliveries, tracker,
    observe: async (active) => tracker.observe({
      incidentKey: 'test.episode', active, threshold: 3, title: 'Episode', body: 'test',
    }),
  };
}

void test('incident episodes enforce threshold, single delivery, silent pending close, and clean reopening', async () => {
  const cases: readonly { readonly sequence: readonly boolean[]; readonly expected: readonly boolean[] }[] = [
    { sequence: [true, true, false], expected: [] },
    { sequence: [true, true, true], expected: [false] },
    { sequence: [true, true, true, true, true], expected: [false] },
    { sequence: [true, true, true, false], expected: [false, true] },
    { sequence: [true, true, true, false, true, false], expected: [false, true] },
    { sequence: [true, true, true, false, true, true, false], expected: [false, true] },
    { sequence: [true, true, true, false, true, true, true, false], expected: [false, true, false, true] },
  ];
  for (const item of cases) {
    const harness = incidentHarness();
    for (const active of item.sequence) await harness.observe(active);
    assert.deepEqual(harness.deliveries, item.expected);
  }
});

void test('incident persistence prevents restart duplicates and recovered state starts a fresh episode', async () => {
  const first = incidentHarness();
  await first.observe(true);
  await first.observe(true);
  await first.observe(true);
  const restarted = incidentHarness(first.store);
  await restarted.observe(true);
  assert.deepEqual([...first.deliveries, ...restarted.deliveries], [false]);
  await restarted.observe(false);
  const afterRecovery = incidentHarness(first.store);
  await afterRecovery.observe(true);
  await afterRecovery.observe(false);
  assert.deepEqual(afterRecovery.deliveries, []);
  assert.equal(first.store.records.get('test.episode')?.occurrenceCount, 1);
  assert.equal(first.store.records.get('test.episode')?.lastNotifiedAt, null);
});

void test('acceptance semantics retain a below-threshold episode without classifying it as unresolved notified', async () => {
  const harness = incidentHarness();
  await harness.observe(true);
  const pending = harness.store.records.get('test.episode');
  assert.equal(pending?.isOpen, true);
  assert.equal(pending?.occurrenceCount, 1);
  assert.equal(pending?.lastNotifiedAt, null);
  assert.equal(pending?.isOpen === true && pending.lastNotifiedAt !== null, false);
});

void test('incident failures emit credential-safe structured events and bound duplicate recovery after a close failure', async () => {
  const events: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const readStore = new MemoryIncidentStore();
  readStore.failRead = true;
  const readTracker = new IncidentTracker({
    store: readStore, transports: [], onEvent: (event, fields) => events.push({ event, fields }),
  });
  await readTracker.observe({ incidentKey: 'test.read', active: true, threshold: 3, title: 'Read', body: 'test' });
  assert.equal(events[0]?.event, 'notification.state_read_failed');
  assert.deepEqual(events[0]?.fields, {
    incidentKey: 'test.read', operation: 'read', errorName: 'Error', errorCode: 'XX001',
  });

  const writeStore = new MemoryIncidentStore();
  writeStore.failSave = true;
  const writeTracker = new IncidentTracker({
    store: writeStore, transports: [], onEvent: (event, fields) => events.push({ event, fields }),
  });
  await writeTracker.observe({ incidentKey: 'test.write', active: true, threshold: 3, title: 'Write', body: 'test' });
  assert.equal(events.some(({ event }) => event === 'notification.state_write_failed'), true);

  const closeHarness = incidentHarness();
  await closeHarness.observe(true); await closeHarness.observe(true); await closeHarness.observe(true);
  closeHarness.store.failClose = true;
  await closeHarness.observe(false);
  await closeHarness.observe(false);
  assert.deepEqual(closeHarness.deliveries, [false, true]);
});

void test('failed and zero-row ACTIVE markers converge without repeating delivery and survive restart', async () => {
  for (const failureMode of ['throw', 'zero-row'] as const) {
    const harness = incidentHarness();
    await harness.observe(true);
    await harness.observe(true);
    if (failureMode === 'throw') harness.store.failMark = true;
    else harness.store.zeroMark = true;

    assert.equal(await harness.observe(true), 'opened');
    assert.deepEqual(harness.deliveries, [false]);
    assert.equal(harness.store.records.get('test.episode')?.lastNotifiedAt, null);

    harness.store.failMark = false;
    harness.store.zeroMark = false;
    assert.equal(await harness.observe(true), 'notified');
    assert.deepEqual(harness.deliveries, [false]);
    assert.notEqual(harness.store.records.get('test.episode')?.lastNotifiedAt, null);

    const restarted = incidentHarness(harness.store);
    assert.equal(await restarted.observe(true), 'opened');
    assert.deepEqual(restarted.deliveries, []);
  }
});

void test('failed and zero-row episode saves defer ACTIVE until persistence converges', async () => {
  for (const failureMode of ['throw', 'zero-row'] as const) {
    const harness = incidentHarness();
    await harness.observe(true);
    await harness.observe(true);
    if (failureMode === 'throw') harness.store.failSave = true;
    else harness.store.zeroSave = true;

    assert.equal(await harness.observe(true), 'opened');
    assert.deepEqual(harness.deliveries, []);
    assert.equal(harness.store.records.get('test.episode')?.occurrenceCount, 2);
    assert.equal(harness.store.records.get('test.episode')?.lastNotifiedAt, null);

    harness.store.failSave = false;
    harness.store.zeroSave = false;
    assert.equal(await harness.observe(true), 'notified');
    assert.deepEqual(harness.deliveries, [false]);
    assert.notEqual(harness.store.records.get('test.episode')?.lastNotifiedAt, null);
  }
});

void test('failed and zero-row closure retries without repeating RECOVERY and stays closed after restart', async () => {
  for (const failureMode of ['throw', 'zero-row'] as const) {
    const harness = incidentHarness();
    await harness.observe(true);
    await harness.observe(true);
    await harness.observe(true);
    if (failureMode === 'throw') harness.store.failClose = true;
    else harness.store.zeroClose = true;

    assert.equal(await harness.observe(false), 'opened');
    assert.deepEqual(harness.deliveries, [false, true]);
    assert.equal(harness.store.records.get('test.episode')?.isOpen, true);

    harness.store.failClose = false;
    harness.store.zeroClose = false;
    assert.equal(await harness.observe(false), 'recovered');
    assert.deepEqual(harness.deliveries, [false, true]);
    assert.equal(harness.store.records.get('test.episode')?.isOpen, false);

    const restarted = incidentHarness(harness.store);
    assert.equal(await restarted.observe(false), 'none');
    assert.deepEqual(restarted.deliveries, []);
  }
});

void test('PostgreSQL incident updates require an affected row', async () => {
  const store = new PostgresIncidentStore({
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  } as never);
  assert.equal(await store.saveOpen({
    incidentKey: 'test.missing', occurrenceCount: 1, details: {},
  }), false);
  assert.equal(await store.markNotified('test.missing'), false);
  assert.equal(await store.close('test.missing'), false);
});

void test('a neutral observation retries a failed ACTIVE marker without repeating delivery', async () => {
  const store = new MemoryIncidentStore();
  const deliveries: boolean[] = [];
  const events: { readonly event: string; readonly fields: Readonly<Record<string, unknown>> }[] = [];
  const tracker = new IncidentTracker({
    store,
    transports: [{
      name: 'fake', send: (message) => { deliveries.push(message.recovery); return Promise.resolve(); },
    }],
    onEvent: (event, fields) => events.push({ event, fields }),
  });
  const observeRate = async (rate: number) => tracker.observe({
    incidentKey: 'test.neutral-retry', active: rate < 0.02,
    recoveryObserved: rate > 0.05, recoveryThreshold: 3,
    threshold: 3, title: 'Matching', body: String(rate),
  });
  await observeRate(0.01);
  await observeRate(0.01);
  store.zeroMark = true;
  await observeRate(0.01);
  assert.deepEqual(deliveries, [false]);
  assert.equal(events.some(({ event, fields }) =>
    event === 'notification.state_write_failed' && fields.errorName === 'StateNotUpdated'), true);

  store.zeroMark = false;
  assert.equal(await observeRate(0.03), 'opened');
  assert.deepEqual(deliveries, [false]);
  assert.notEqual(store.records.get('test.neutral-retry')?.lastNotifiedAt, null);
});

void test('partial-channel incident delivery retries only the failed channel and recovers only channels that saw ACTIVE', async () => {
  const store = new MemoryIncidentStore();
  let telegramCalls = 0;
  let smtpCalls = 0;
  const events: string[] = [];
  const tracker = new IncidentTracker({
    store,
    transports: [
      { name: 'telegram', send: () => { telegramCalls += 1; return Promise.resolve(); } },
      { name: 'smtp', send: () => {
        smtpCalls += 1;
        return smtpCalls === 1 ? Promise.reject(new Error('SMTP unavailable')) : Promise.resolve();
      } },
    ],
    onEvent: (event) => events.push(event),
  });
  const observe = async (active: boolean) => tracker.observe({
    incidentKey: 'test.partial-episode', active, threshold: 3, title: 'Partial', body: 'test',
  });
  await observe(true); await observe(true); await observe(true);
  assert.deepEqual({ telegramCalls, smtpCalls }, { telegramCalls: 1, smtpCalls: 1 });
  assert.equal(events.includes('notification.delivery_failed'), true);
  await observe(true);
  assert.deepEqual({ telegramCalls, smtpCalls }, { telegramCalls: 1, smtpCalls: 2 });
  await observe(false);
  assert.deepEqual({ telegramCalls, smtpCalls }, { telegramCalls: 2, smtpCalls: 3 });

  let recoveryOnlyTelegram = 0;
  let neverActiveSmtp = 0;
  const partialThenHealthy = new IncidentTracker({
    store: new MemoryIncidentStore(),
    transports: [
      { name: 'telegram', send: () => { recoveryOnlyTelegram += 1; return Promise.resolve(); } },
      { name: 'smtp', send: () => { neverActiveSmtp += 1; return Promise.reject(new Error('down')); } },
    ],
  });
  const partial = async (active: boolean) => partialThenHealthy.observe({
    incidentKey: 'test.partial-close', active, threshold: 3, title: 'Partial', body: 'test',
  });
  await partial(true); await partial(true); await partial(true); await partial(false);
  assert.deepEqual({ recoveryOnlyTelegram, neverActiveSmtp }, { recoveryOnlyTelegram: 2, neverActiveSmtp: 1 });
});

void test('heartbeat failure episodes notify and recover only after crossing the threshold', async () => {
  const notified = incidentHarness();
  await notified.observe(true); await notified.observe(true); await notified.observe(true); await notified.observe(false);
  assert.deepEqual(notified.deliveries, [false, true]);
  assert.equal(notified.store.records.get('test.episode')?.isOpen, false);
  const pending = incidentHarness();
  await pending.observe(true); await pending.observe(false);
  assert.deepEqual(pending.deliveries, []);
});

void test('matching hysteresis requires consecutive low entry and consecutive high recovery observations', async () => {
  const harness = incidentHarness();
  const observeRate = async (rate: number) => harness.tracker.observe({
    incidentKey: 'test.episode',
    active: rate < 0.02,
    recoveryObserved: rate > 0.05,
    recoveryThreshold: 3,
    threshold: 3,
    title: 'Matching', body: String(rate),
  });
  for (const rate of [0.019, 0.021, 0.019, 0.021, 0.019]) await observeRate(rate);
  assert.deepEqual(harness.deliveries, []);
  for (const rate of [0.019, 0.019, 0.03, 0.049, 0.051, 0.049, 0.051, 0.051, 0.051]) await observeRate(rate);
  assert.deepEqual(harness.deliveries, [false, true]);
});

void test('long-running static cache replaces candidates when active/previous identities change', () => {
  const initial: StaticMatchIndex = {
    versionIdentity: { activeFeedVersionId: '10', previousFeedVersionId: '9' },
    candidates: [activeTrip, previousTrip],
  };
  const activated: StaticMatchIndex = {
    versionIdentity: { activeFeedVersionId: '11', previousFeedVersionId: '10' },
    candidates: [{ ...activeTrip, feedVersionId: '11' }, { ...activeTrip, versionPosition: 'previous' }],
  };
  const merged = mergeStaticMatchIndex(initial, activated);
  assert.deepEqual(merged.versionIdentity, activated.versionIdentity);
  assert.deepEqual(merged.candidates.map((candidate) => candidate.feedVersionId), ['11', '10']);
  assert.equal(merged.candidates.some((candidate) => candidate.feedVersionId === '9'), false);
});

void test('cold static-index failure is deferred safely and a later cycle retries normally', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atodotren-cold-index-'));
  const spool = new OutageSpool(join(directory, 'spool.sqlite'), 2_000_000);
  let loads = 0;
  let clock = Date.parse('2099-08-17T10:00:00.000Z');
  const body = encode([{
    id: 'tu-cold', tripUpdate: {
      trip: { tripId: '10T1', startDate: '20260817' }, timestamp: 1_725_000_001,
      stopTimeUpdate: [{ stopSequence: 1, arrival: { delay: 30 } }],
    },
  }]);
  const unavailablePool = {
    connect: () => Promise.reject(new Error('PostgreSQL unavailable')),
    query: () => Promise.reject(new Error('PostgreSQL unavailable')),
  };
  try {
    const report = await runIngest({
      pool: unavailablePool as never,
      spool,
      cycles: 2,
      config: {
        endpoints: [{ kind: 'trip_updates', url: 'http://localhost/feed', enabled: true }],
        requestTimeoutMs: 1_000, maxResponseBytes: 1_024 * 1024,
        cycleIntervalMs: 1, alertIntervalMs: 60_000, failureThreshold: 3,
        matchingRateMinimum: 0.02, matchingRateRecoveryMinimum: 0.05,
        matchingRecoveryThreshold: 3, malformedRateMaximum: 0.25,
        spoolWarningRatio: 0.75, staleAfterMs: 120_000,
      },
      fetchImplementation: () => Promise.resolve(new Response(body, { status: 200 })),
      loadStaticIndex: () => {
        loads += 1;
        return loads === 1
          ? Promise.reject(new Error('PostgreSQL unavailable'))
          : Promise.resolve({
            versionIdentity: { activeFeedVersionId: '10' }, candidates: [activeTrip],
          });
      },
      sleep: () => Promise.resolve(),
      now: () => { const value = new Date(clock); clock += 1_000; return value; },
    });
    assert.equal(report.successfulCycles, 1);
    assert.equal(report.unmatched, 0);
    const first = spool.peek();
    assert.equal(first?.envelope.poll.resultClass, 'persistence_error');
    assert.equal(first?.envelope.poll.errorCode, 'static.index_unavailable');
    assert.equal(first?.envelope.batch, undefined);
    if (first !== undefined) spool.acknowledge(first.sequence);
    const second = spool.peek();
    assert.equal(second?.envelope.batch?.matchedMadridCount, 1);
  } finally {
    spool.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('canonical maintenance runs once per cycle and a failure makes only that cycle unsuccessful', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atodotren-canonical-maintenance-'));
  const spool = new OutageSpool(join(directory, 'spool.sqlite'), 2_000_000);
  let maintenanceRuns = 0;
  let clock = Date.parse('2099-08-17T10:00:00.000Z');
  const events: string[] = [];
  const body = encode([{
    id: 'tu-maintenance', tripUpdate: {
      trip: { tripId: '10T1', startDate: '20260817' }, timestamp: 1_725_000_001,
      stopTimeUpdate: [{ stopSequence: 1, arrival: { delay: 30 } }],
    },
  }]);
  const unavailablePool = {
    connect: () => Promise.reject(new Error('PostgreSQL unavailable')),
    query: () => Promise.reject(new Error('PostgreSQL unavailable')),
  };
  try {
    const report = await runIngest({
      pool: unavailablePool as never,
      spool,
      cycles: 2,
      config: {
        endpoints: [{ kind: 'trip_updates', url: 'http://localhost/feed', enabled: true }],
        requestTimeoutMs: 1_000, maxResponseBytes: 1_024 * 1_024,
        cycleIntervalMs: 1, alertIntervalMs: 60_000, failureThreshold: 3,
        matchingRateMinimum: 0.02, matchingRateRecoveryMinimum: 0.05,
        matchingRecoveryThreshold: 3, malformedRateMaximum: 0.25,
        spoolWarningRatio: 0.75, staleAfterMs: 120_000,
      },
      fetchImplementation: () => Promise.resolve(new Response(body, { status: 200 })),
      loadStaticIndex: () => Promise.resolve(index),
      afterCycle: () => {
        maintenanceRuns += 1;
        return maintenanceRuns === 1
          ? Promise.reject(new Error('Canonical maintenance failed'))
          : Promise.resolve();
      },
      onEvent: (event) => events.push(event),
      sleep: () => Promise.resolve(),
      now: () => { const value = new Date(clock); clock += 1_000; return value; },
    });
    assert.equal(maintenanceRuns, 2);
    assert.equal(report.successfulCycles, 1);
    assert.equal(events.filter((event) => event === 'canonical.maintenance_failed').length, 1);
  } finally {
    spool.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function poll(id: string): PollRecord {
  return {
    idempotencyKey: id.padEnd(64, '0'), feedKind: 'vehicle_positions',
    startedAt: '2099-08-17T10:00:00.000Z', completedAt: '2099-08-17T10:00:01.000Z',
    capturedAt: '2099-08-17T10:00:01.000Z', feedHeaderTimestamp: 1_725_000_000,
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
      feedKind: 'vehicle_positions', capturedAt: '2099-08-17T10:00:01.000Z',
      headerTimestamp: 1_725_000_000, matchedMadridCount: 1, nonMadridCount: 0,
      unmatchedCount: 0, invalidCount: 0, filteredEntities: [],
      operations: [{
        kind: 'vehicle_state', idempotencyKey: 'a'.repeat(64), stateKey: 'state',
        capturedAt: '2099-08-17T10:00:01.000Z', feedVersionId: '10', sourceTripId: '10T1',
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
        feedHeaderTimestamp: 1_725_000_000, capturedAt: '2099-08-17T10:00:02.000Z',
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
