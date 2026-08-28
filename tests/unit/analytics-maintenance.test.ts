import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import {
  executeMilestone4Cli,
  type Milestone4Dependencies,
} from '@atodotren/worker/m4-cli';
import { selectFinalizeDates } from '@atodotren/worker/analytics';
import { runMaintenance } from '@atodotren/worker/maintenance';

function invoke(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
  extra: Omit<Milestone4Dependencies, 'environment' | 'stdout' | 'stderr'> = {},
) {
  let stdout = '';
  let stderr = '';
  const stdoutStream = new Writable({
    write(chunk: Buffer, _encoding, callback) { stdout += chunk.toString(); callback(); },
  });
  const stderrStream = new Writable({
    write(chunk: Buffer, _encoding, callback) { stderr += chunk.toString(); callback(); },
  });
  return executeMilestone4Cli(arguments_, {
    ...extra, environment, stdout: stdoutStream, stderr: stderrStream,
  }).then((code) => ({ code, stdout, stderr }));
}

function connection() {
  return Promise.resolve({
    pool: {} as never,
    db: {} as never,
    close: () => Promise.resolve(),
  });
}

void test('Milestone 4 root and command help expose aggregate/finalize without claiming they are deferred', async () => {
  const root = await invoke(['--help']);
  assert.equal(root.code, 0);
  assert.match(root.stdout, /aggregate\s+Recompute bounded dirty daily aggregate scopes/u);
  assert.match(root.stdout, /finalize\s+Verify service days, seal months, and gate retention/u);
  assert.match(root.stdout, /maintain\s+Run isolated canonical and aggregate maintenance/u);
  assert.doesNotMatch(root.stdout, /aggregate.*planned for a later milestone/u);
  assert.equal((await invoke(['aggregate', '--help'])).code, 0);
  assert.equal((await invoke(['finalize', '--help'])).code, 0);
});

void test('Milestone 4 CLI rejects unbounded options and requires explicit retention confirmation', async () => {
  assert.equal((await invoke(['aggregate', '--limit', '0'])).code, 2);
  assert.equal((await invoke(['aggregate', '--service-date', '20260822'])).code, 2);
  assert.equal((await invoke(['finalize', '--month', '2026-08-02'])).code, 2);
  assert.equal((await invoke(['finalize', '--retention', '--authorize-retention'])).code, 2);
  assert.equal((await invoke(['finalize', '--apply-retention'])).code, 2);
  assert.equal((await invoke(['finalize', '--confirm-retention', 'DROP-VERIFIED-PARTITIONS'])).code, 2);
  assert.equal((await invoke(['finalize', '--acknowledge-incomplete', 'outage'])).code, 2);
});

void test('maintenance defaults to the pre-digest finalization window and rejects an inverted window', async () => {
  const environment = { DATABASE_URL: 'postgresql://worker:password@localhost/atodotren' };
  let received: { finalizeAfter: string; finalizeBefore: string } | undefined;
  const result = await invoke(['maintain', '--once'], environment, {
    connect: connection,
    maintenance: (options) => {
      received = { finalizeAfter: options.finalizeAfter, finalizeBefore: options.finalizeBefore };
      return Promise.resolve({
        cyclesAttempted: 1, operationFailures: 0, finalizationAttempts: 0, stoppedBySignal: false,
      });
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(received, { finalizeAfter: '04:30', finalizeBefore: '06:30' });

  const invalid = await invoke(['maintain', '--once'], {
    ...environment, MAINTENANCE_FINALIZE_AFTER: '06:30', MAINTENANCE_FINALIZE_BEFORE: '04:30',
  });
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /must be earlier/u);
});

void test('automatic finalization scans the retained 35-day window oldest first', async () => {
  let sql = '';
  let values: readonly unknown[] = [];
  const pool = {
    query: (statement: string, parameters: readonly unknown[]) => {
      sql = statement;
      values = parameters;
      return Promise.resolve({ rows: [{ service_date: '2026-07-20' }] });
    },
  } as never;
  const dates = await selectFinalizeDates(pool, undefined, 'aggregate-v1', new Date('2026-08-23T12:00:00Z'), 7);
  assert.deepEqual(dates, ['2026-07-20']);
  assert.match(sql, /::date - 35/u);
  assert.match(sql, /ORDER BY service_date/u);
  assert.deepEqual(values, ['aggregate-v1', new Date('2026-08-23T12:00:00Z'), 7]);
});

void test('finalize passes an explicit outage acknowledgement through to the operation', async () => {
  const environment = { DATABASE_URL: 'postgresql://worker:password@localhost/atodotren' };
  let received: string | undefined;
  const result = await invoke([
    'finalize', '--service-date', '2026-08-01', '--acknowledge-incomplete', 'confirmed Renfe outage',
  ], environment, {
    connect: connection,
    finalize: (options) => {
      received = options.acknowledgeIncomplete;
      return Promise.resolve({
        command: 'finalize', algorithmVersion: 'aggregate-v1', checkedAt: '2026-08-23T12:00:00.000Z',
        serviceDays: [], months: [], operationsSummaries: [],
        retention: { mode: 'none', candidates: [], authorizations: [], drops: [], liveState: null },
        errors: [], durationMs: 0,
      });
    },
  });
  assert.equal(result.code, 0);
  assert.equal(received, 'confirmed Renfe outage');
});

void test('aggregate dispatches a bounded service date and preserves JSON exit semantics', async () => {
  const environment = { DATABASE_URL: 'postgresql://worker:password@localhost/atodotren' };
  let closed = false;
  const result = await invoke([
    'aggregate', '--service-date', '2026-08-22', '--limit', '7', '--algorithm-version', 'aggregate-v7',
  ], environment, {
    connect: () => Promise.resolve({
      pool: {} as never, db: {} as never,
      close: () => { closed = true; return Promise.resolve(); },
    }),
    aggregate: (options) => {
      assert.equal(options.serviceDate, '2026-08-22');
      assert.equal(options.limit, 7);
      assert.equal(options.algorithmVersion, 'aggregate-v7');
      return Promise.resolve({
        command: 'aggregate', algorithmVersion: 'aggregate-v7', scopesAttempted: 1,
        succeeded: 1, noops: 0, failed: 0,
        results: [{ status: 'succeeded', sourceRows: 20, aggregateRows: 5 }],
        errors: [], durationMs: 2,
      });
    },
  });
  assert.equal(result.code, 0);
  assert.equal(closed, true);
  assert.deepEqual(JSON.parse(result.stdout), {
    command: 'aggregate', algorithmVersion: 'aggregate-v7', scopesAttempted: 1,
    succeeded: 1, noops: 0, failed: 0,
    results: [{ status: 'succeeded', sourceRows: 20, aggregateRows: 5 }],
    errors: [], durationMs: 2,
  });
});

void test('finalize exposes separate dry-run, authorize, and confirmed apply modes', async () => {
  const environment = { DATABASE_URL: 'postgresql://worker:password@localhost/atodotren' };
  const modes: string[] = [];
  const finalize: NonNullable<Milestone4Dependencies['finalize']> = (options) => {
    modes.push(options.retentionMode ?? 'none');
    return Promise.resolve({
      command: 'finalize', algorithmVersion: options.algorithmVersion ?? 'aggregate-v1',
      checkedAt: (options.now ?? new Date('2026-08-22T12:00:00Z')).toISOString(),
      serviceDays: [], months: [], operationsSummaries: [],
      retention: {
        mode: options.retentionMode ?? 'none', candidates: [], authorizations: [], drops: [], liveState: null,
      },
      errors: [], durationMs: 1,
    });
  };
  for (const arguments_ of [
    ['finalize', '--retention'],
    ['finalize', '--authorize-retention'],
    ['finalize', '--apply-retention', '--confirm-retention', 'DROP-VERIFIED-PARTITIONS'],
  ] as const) {
    const result = await invoke(arguments_, environment, { connect: connection, finalize });
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }
  assert.deepEqual(modes, ['plan', 'authorize', 'apply']);
});

void test('isolated maintenance retries finalization until verified and then stops for the Madrid day', async () => {
  const instants = [
    new Date('2026-08-22T02:30:00Z'),
    new Date('2026-08-22T02:35:00Z'),
    new Date('2026-08-22T02:40:00Z'),
  ];
  let nowIndex = 0;
  let canonicalRuns = 0;
  let aggregateRuns = 0;
  let finalizationRuns = 0;
  const report = await runMaintenance({
    pool: {} as never, cycles: 3, intervalMs: 1,
    finalizeAfter: '04:30', finalizeBefore: '06:30',
    now: () => instants[Math.min(nowIndex++, instants.length - 1)]!,
    sleep: () => Promise.resolve(),
    canonicalize: () => {
      canonicalRuns += 1;
      return Promise.resolve({
        errors: {}, journeysCreated: 0, journeysUpdated: 0, journeysClosed: 0,
        journeyStopsMaterialized: 0,
      } as never);
    },
    closeJourneys: () => {
      canonicalRuns += 1;
      return Promise.resolve({ errors: {}, journeysClosed: 0 } as never);
    },
    aggregate: () => {
      aggregateRuns += 1;
      return Promise.resolve({
        command: 'aggregate', algorithmVersion: 'aggregate-v1', scopesAttempted: 0,
        succeeded: 0, noops: 0, failed: 0, results: [], errors: [], durationMs: 0,
      });
    },
    finalize: () => {
      finalizationRuns += 1;
      return Promise.resolve({
        command: 'finalize', algorithmVersion: 'aggregate-v1', checkedAt: instants[0]!.toISOString(),
        serviceDays: finalizationRuns === 1 ? [] : [{ status: 'verified' }],
        months: [], operationsSummaries: [],
        retention: { mode: 'none', candidates: [], authorizations: [], drops: [], liveState: null },
        errors: finalizationRuns === 1 ? ['blocked'] : [], durationMs: 0,
      });
    },
  });
  assert.equal(report.operationFailures, 1);
  assert.equal(report.finalizationAttempts, 2);
  assert.equal(canonicalRuns, 6);
  assert.equal(aggregateRuns, 3);
  assert.equal(finalizationRuns, 2);
});

void test('maintenance reports failures without stopping later cycles', async () => {
  let canonicalRuns = 0;
  const events: string[] = [];
  const report = await runMaintenance({
    pool: {} as never, cycles: 2, intervalMs: 1,
    finalizeAfter: '23:00', finalizeBefore: '23:59',
    now: () => new Date('2026-08-22T10:00:00Z'), sleep: () => Promise.resolve(),
    onEvent: (event) => events.push(event),
    canonicalize: () => {
      canonicalRuns += 1;
      return canonicalRuns === 1 ? Promise.reject(new Error('blocked')) : Promise.resolve({ errors: {} } as never);
    },
    closeJourneys: () => Promise.resolve({ errors: {} } as never),
    aggregate: () => Promise.resolve({
      command: 'aggregate', algorithmVersion: 'aggregate-v1', scopesAttempted: 0,
      succeeded: 0, noops: 0, failed: 0, results: [], errors: [], durationMs: 0,
    }),
  });
  assert.equal(canonicalRuns, 2);
  assert.equal(report.operationFailures, 1);
  assert.equal(events.filter((event) => event === 'maintenance.operation_failed').length, 1);
});

void test('maintenance stops retrying at the provisional digest cutoff', async () => {
  const instants = [
    new Date('2026-08-22T04:25:00Z'),
    new Date('2026-08-22T04:30:00Z'),
  ];
  let nowIndex = 0;
  let finalizationRuns = 0;
  const report = await runMaintenance({
    pool: {} as never, cycles: 2, intervalMs: 1,
    finalizeAfter: '04:30', finalizeBefore: '06:30',
    now: () => instants[Math.min(nowIndex++, instants.length - 1)]!,
    sleep: () => Promise.resolve(),
    canonicalize: () => Promise.resolve({ errors: {} } as never),
    closeJourneys: () => Promise.resolve({ errors: {} } as never),
    aggregate: () => Promise.resolve({
      command: 'aggregate', algorithmVersion: 'aggregate-v1', scopesAttempted: 0,
      succeeded: 0, noops: 0, failed: 0, results: [], errors: [], durationMs: 0,
    }),
    finalize: () => {
      finalizationRuns += 1;
      return Promise.resolve({
        command: 'finalize', algorithmVersion: 'aggregate-v1', checkedAt: instants[0]!.toISOString(),
        serviceDays: [{ status: 'blocked' }], months: [], operationsSummaries: [],
        retention: { mode: 'none', candidates: [], authorizations: [], drops: [], liveState: null },
        errors: ['blocked'], durationMs: 0,
      });
    },
  });
  assert.equal(report.finalizationAttempts, 1);
  assert.equal(finalizationRuns, 1);
});

void test('maintenance shutdown interrupts the periodic sleep promptly', async () => {
  const controller = new AbortController();
  const started = performance.now();
  const running = runMaintenance({
    pool: {} as never, intervalMs: 300_000,
    finalizeAfter: '23:00', finalizeBefore: '23:59', signal: controller.signal,
    now: () => new Date('2026-08-22T10:00:00Z'),
    canonicalize: () => Promise.resolve({ errors: {} } as never),
    closeJourneys: () => Promise.resolve({ errors: {} } as never),
    aggregate: () => Promise.resolve({
      command: 'aggregate', algorithmVersion: 'aggregate-v1', scopesAttempted: 0,
      succeeded: 0, noops: 0, failed: 0, results: [], errors: [], durationMs: 0,
    }),
  });
  setTimeout(() => controller.abort(), 10);
  const report = await running;
  assert.equal(report.cyclesAttempted, 1);
  assert.equal(report.stoppedBySignal, true);
  assert.ok(performance.now() - started < 1_000);
});
