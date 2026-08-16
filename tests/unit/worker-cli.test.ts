import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

async function runWorker(arguments_: readonly string[]): Promise<{
  readonly code: number | null;
  readonly stdout: string;
}> {
  const child = spawn(process.execPath, ['apps/worker/dist/cli.js', ...arguments_], {
    cwd: process.cwd(),
    env: {},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  await once(child, 'close');
  return { code: child.exitCode, stdout };
}

void test('planned but unavailable worker commands fail explicitly', async () => {
  const result = await runWorker(['ingest', '--once']);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /command\.not_implemented/);
  assert.match(result.stdout, /not implemented/);
});
