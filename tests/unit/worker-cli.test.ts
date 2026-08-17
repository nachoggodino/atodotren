import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import { executeCli } from '@atodotren/worker/dispatcher';

function invoke(arguments_: readonly string[], environment: Readonly<Record<string, string | undefined>> = {}) {
  let stdout = '';
  let stderr = '';
  const stdoutStream = new Writable({ write(chunk: Buffer, _encoding, callback) { stdout += chunk.toString(); callback(); } });
  const stderrStream = new Writable({ write(chunk: Buffer, _encoding, callback) { stderr += chunk.toString(); callback(); } });
  return executeCli(arguments_, { environment, stdout: stdoutStream, stderr: stderrStream }).then((code) => ({ code, stdout, stderr }));
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

void test('planned but unavailable commands are runtime failures and invalid options remain usage errors', async () => {
  for (const command of ['ingest', 'import-static', 'aggregate', 'finalize', 'replay', 'report']) {
    const planned = await invoke(command === 'ingest' ? [command, '--once'] : [command]);
    assert.equal(planned.code, 1);
    assert.match(planned.stdout, /command\.not_implemented/u);
  }
  assert.equal((await invoke(['ingest', '--unknown'])).code, 2);
  assert.equal((await invoke(['report', '--unknown'])).code, 2);
});
