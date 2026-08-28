import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  mergeStaticMatchIndex,
  OutageSpool,
  runIngest,
  type NormalizedBatch,
  type StaticMatchIndex,
} from '@atodotren/gtfs-realtime';
import { runMaintenance } from '@atodotren/worker/maintenance';

import { activeTrip, encodeRealtime, previousTrip, realtimePoll, staticIndex } from '../helpers/realtime.js';

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
  const body = encodeRealtime([{
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

void test('a blocked maintenance process cannot delay fake realtime cycles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atodotren-canonical-maintenance-'));
  const spool = new OutageSpool(join(directory, 'spool.sqlite'), 2_000_000);
  let clock = Date.parse('2099-08-17T10:00:00.000Z');
  const body = encodeRealtime([{
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
    let maintenanceStarted = false;
    void runMaintenance({
      pool: {} as never, cycles: 1, intervalMs: 300_000,
      finalizeAfter: '23:00', finalizeBefore: '23:59',
      canonicalize: () => {
        maintenanceStarted = true;
        return new Promise(() => undefined);
      },
    });
    const report = await Promise.race([runIngest({
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
      loadStaticIndex: () => Promise.resolve(staticIndex),
      sleep: () => Promise.resolve(),
      now: () => { const value = new Date(clock); clock += 1_000; return value; },
    }), new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('ingestion was delayed')), 2_000))]);
    assert.equal(maintenanceStarted, true);
    assert.equal(report.successfulCycles, 2);
  } finally {
    spool.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
    const stored = spool.enqueue({ poll: realtimePoll('1'), batch });
    assert.equal(stored.stored, true);
    assert.equal(stored.droppedVehiclePositions, 0);
    assert.equal(spool.enqueue({ poll: realtimePoll('1'), batch }).duplicate, true);
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
    const priorityStored = spool.enqueue({ poll: realtimePoll('2'), batch: important });
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
