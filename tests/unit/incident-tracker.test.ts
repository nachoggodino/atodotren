import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IncidentTracker,
  PostgresIncidentStore,
  RetryingAlertDelivery,
  type IncidentRecord,
  type IncidentStore,
} from '@atodotren/gtfs-realtime';

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
