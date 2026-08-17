import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import { executeCli, type DispatcherDependencies } from '@atodotren/worker/dispatcher';

function invoke(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
  extra: Omit<DispatcherDependencies, 'environment' | 'stdout' | 'stderr'> = {},
) {
  let stdout = '';
  let stderr = '';
  const stdoutStream = new Writable({ write(chunk: Buffer, _encoding, callback) { stdout += chunk.toString(); callback(); } });
  const stderrStream = new Writable({ write(chunk: Buffer, _encoding, callback) { stderr += chunk.toString(); callback(); } });
  return executeCli(arguments_, { ...extra, environment, stdout: stdoutStream, stderr: stderrStream }).then((code) => ({ code, stdout, stderr }));
}

void test('importable dispatch handles root help, version, and no command predictably', async () => {
  const help = await invoke(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Atodotren worker 0\.0\.0/u);
  const version = await invoke(['--version']);
  assert.deepEqual(version, { code: 0, stdout: '0.0.0\n', stderr: '' });
  const missing = await invoke([]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /command is required/u);
});

void test('unknown commands and options are usage errors', async () => {
  for (const arguments_ of [['unknown'], ['--wat'], ['doctor', '--wat']]) {
    assert.equal((await invoke(arguments_)).code, 2);
  }
});

void test('doctor help succeeds while configuration failures are runtime failures', async () => {
  const help = await invoke(['doctor', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /worker doctor/u);
  const failure = await invoke(['doctor']);
  assert.equal(failure.code, 1);
  assert.match(failure.stdout, /config\.invalid/u);
});

void test('later commands remain unavailable and realtime options are strict', async () => {
  for (const command of ['aggregate', 'finalize', 'report']) {
    const planned = await invoke([command]);
    assert.equal(planned.code, 1);
    assert.match(planned.stdout, /command\.not_implemented/u);
  }
  assert.equal((await invoke(['ingest', '--unknown'])).code, 2);
  assert.equal((await invoke(['ingest', '--once', '--cycles', '2'])).code, 2);
  assert.equal((await invoke(['ingest', '--cycles', '0'])).code, 2);
  assert.equal((await invoke(['ingest', '--help'])).code, 0);
  assert.equal((await invoke(['replay', '--help'])).code, 0);
  assert.equal((await invoke(['report', '--unknown'])).code, 2);
});

void test('ingest and replay dispatch bounded modes with predictable reports', async () => {
  const environment = {
    DATABASE_URL: 'postgresql://worker:password@localhost/atodotren',
    SQLITE_SPOOL_PATH: `/tmp/atodotren-cli-${process.pid}.sqlite`,
  };
  const connect: NonNullable<DispatcherDependencies['connect']> = () => Promise.resolve({
    pool: {} as never,
    db: {} as never,
    close: () => Promise.resolve(),
  });
  const ingest = await invoke(['ingest', '--cycles', '2'], environment, {
    connect,
    ingest: (options) => Promise.resolve({
      cyclesAttempted: options.cycles ?? 0, successfulCycles: 2,
      postgresPersistedFeeds: 4, spooledFeeds: 0, replayedFeeds: 0,
      evidenceInserted: 2, evidenceRepeated: 1, matchedMadrid: 4,
      nonMadrid: 5, unmatched: 0, invalid: 0, responseBytes: 100,
      stoppedBySignal: false,
    }),
  });
  assert.equal(ingest.code, 0);
  assert.equal((JSON.parse(ingest.stdout) as { cyclesAttempted: number }).cyclesAttempted, 2);
  const replay = await invoke(['replay'], environment, {
    connect,
    replay: () => Promise.resolve({ replayed: 3, pending: 0 }),
  });
  assert.equal(replay.code, 0);
  assert.equal((JSON.parse(replay.stdout) as { replayed: number }).replayed, 3);
});

void test('import-static exposes strict options and preserves JSON report exit semantics', async () => {
  assert.equal((await invoke(['import-static', '--help'])).code, 0);
  assert.equal((await invoke(['import-static', '--url', 'https://example.test/a.zip', '--file', 'a.zip'])).code, 2);
  assert.equal((await invoke(['import-static', '--unknown'])).code, 2);

  const environment = { DATABASE_URL: 'postgresql://worker:password@localhost/atodotren' };
  const connect: NonNullable<DispatcherDependencies['connect']> = () => Promise.resolve({
    pool: {} as never,
    db: {} as never,
    close: () => Promise.resolve(),
  });
  const imported = await invoke(['import-static', '--file', 'fixture.zip', '--json'], environment, {
    connect,
    importStatic: (options) => Promise.resolve({
      ok: true,
      result: 'unchanged',
      source: { kind: options.source.kind, display: 'fixture.zip' },
      fetch: { status: 'checksum-match', durationMs: 1 },
      warnings: [],
      rejectionCount: 0,
      activation: 'unchanged',
      timingsMs: {},
      totalDurationMs: 1,
    }),
  });
  assert.equal(imported.code, 0);
  assert.equal((JSON.parse(imported.stdout) as { result: string }).result, 'unchanged');

  const rejected = await invoke(['import-static', '--file', 'fixture.zip', '--json'], environment, {
    connect,
    importStatic: (options) => Promise.resolve({
      ok: false,
      result: 'rejected',
      source: { kind: options.source.kind, display: 'fixture.zip' },
      fetch: { status: 'local', durationMs: 1 },
      warnings: [],
      rejectionCount: 1,
      activation: 'not-attempted',
      timingsMs: {},
      totalDurationMs: 1,
      error: { kind: 'validation', code: 'fixture.invalid', message: 'Fixture rejected' },
    }),
  });
  assert.equal(rejected.code, 1);
  assert.equal((JSON.parse(rejected.stdout) as { error: { code: string } }).error.code, 'fixture.invalid');
});
