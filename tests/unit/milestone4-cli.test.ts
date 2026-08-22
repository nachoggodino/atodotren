import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import {
  executeMilestone4Cli,
  type Milestone4Dependencies,
} from '@atodotren/worker/m4-cli';

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

void test('canonical maintenance aggregates immediately and then at most once per five minutes', async () => {
  const environment = {
    DATABASE_URL: 'postgresql://worker:password@localhost/atodotren',
    SQLITE_SPOOL_PATH: `/tmp/atodotren-m4-cli-${process.pid}.sqlite`,
  };
  const instants = [
    new Date('2026-08-22T10:00:00Z'),
    new Date('2026-08-22T10:01:00Z'),
    new Date('2026-08-22T10:05:00Z'),
  ];
  let nowIndex = 0;
  let canonicalRuns = 0;
  let aggregateRuns = 0;
  const result = await invoke(['ingest', '--cycles', '3', '--canonical-maintenance'], environment, {
    connect: connection,
    now: () => instants[Math.min(nowIndex++, instants.length - 1)]!,
    realtimeIngest: async (options) => {
      for (let cycle = 0; cycle < (options.cycles ?? 0); cycle += 1) await options.afterCycle?.();
      return {
        cyclesAttempted: options.cycles ?? 0, successfulCycles: options.cycles ?? 0,
        postgresPersistedFeeds: 0, spooledFeeds: 0, replayedFeeds: 0,
        evidenceInserted: 0, evidenceRepeated: 0, matchedMadrid: 0,
        nonMadrid: 0, unmatched: 0, invalid: 0, responseBytes: 0, stoppedBySignal: false,
      };
    },
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
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(canonicalRuns, 6);
  assert.equal(aggregateRuns, 2);
});
