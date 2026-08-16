import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateDiskSpace,
  inspectLocalEnvironment,
  parseEnvironmentFile,
  preflightExitCode,
  redactSensitiveText,
} from '@atodotren/config';

const localEnvironment = {
  POSTGRES_DB: 'atodotren',
  POSTGRES_USER: 'postgres',
  POSTGRES_PASSWORD: 'admin-test-value',
  ATODOTREN_WORKER_PASSWORD: 'worker-test-value',
  POSTGRES_PORT: '5432',
  DATABASE_URL: 'postgresql://atodotren_worker:worker-test-value@localhost:5432/atodotren',
  MIGRATION_DATABASE_URL:
    'postgresql://atodotren_migrator:admin-test-value@localhost:5432/atodotren',
  TEST_ADMIN_DATABASE_URL: 'postgresql://postgres:admin-test-value@localhost:5432/atodotren',
  TEST_MIGRATOR_DATABASE_URL:
    'postgresql://atodotren_migrator:admin-test-value@localhost:5432/atodotren',
  TEST_WORKER_DATABASE_URL:
    'postgresql://atodotren_worker:worker-test-value@localhost:5432/atodotren',
} as const;

void test('parses quoted environment values without evaluating shell syntax', () => {
  assert.deepEqual(parseEnvironmentFile("A=plain\nB='quoted value'\n# ignored\nC=\"other\"\n"), {
    A: 'plain',
    B: 'quoted value',
    C: 'other',
  });
});

void test('accepts a coherent local PostgreSQL environment', () => {
  const checks = inspectLocalEnvironment(localEnvironment);
  assert.equal(preflightExitCode(checks), 0);
  assert.ok(checks.every((check) => check.status === 'pass'));
});

void test('rejects placeholders and component-password drift without exposing values', () => {
  const checks = inspectLocalEnvironment({
    ...localEnvironment,
    POSTGRES_PASSWORD: 'change-me',
    TEST_ADMIN_DATABASE_URL:
      'postgresql://postgres:stale-test-value@localhost:5432/atodotren',
  });
  assert.equal(preflightExitCode(checks), 1);
  assert.equal(
    checks.find((check) => check.name === 'environment.placeholders')?.status,
    'fail',
  );
  assert.equal(
    checks.find((check) => check.name === 'database.password-coherence')?.status,
    'fail',
  );
  const output = JSON.stringify(checks);
  assert.doesNotMatch(output, /change-me|stale-test-value/u);
});

void test('rejects an absent required URL', () => {
  const incompleteEnvironment: Record<string, string | undefined> = { ...localEnvironment };
  delete incompleteEnvironment.TEST_MIGRATOR_DATABASE_URL;
  const checks = inspectLocalEnvironment(incompleteEnvironment);
  assert.equal(preflightExitCode(checks), 1);
  assert.match(
    checks.find((check) => check.name === 'environment.required')?.message ?? '',
    /TEST_MIGRATOR_DATABASE_URL/u,
  );
});

void test('redacts PostgreSQL URL passwords and explicitly known secrets', () => {
  const secret = 'unique-sensitive-test-value';
  const redacted = redactSensitiveText(
    `failed postgresql://worker:${secret}@localhost:5432/atodotren token=${secret}`,
    [secret],
  );
  assert.doesNotMatch(redacted, new RegExp(secret, 'u'));
  assert.match(redacted, /postgresql:\/\/worker:\[REDACTED\]@localhost/u);
});

void test('blocking failures produce a nonzero exit and disk thresholds are deterministic', () => {
  assert.equal(preflightExitCode([{ name: 'x', status: 'fail', message: 'blocked' }]), 1);
  assert.equal(evaluateDiskSpace(1 * 1024 ** 3).status, 'fail');
  assert.equal(evaluateDiskSpace(5 * 1024 ** 3).status, 'warn');
  assert.equal(evaluateDiskSpace(12 * 1024 ** 3).status, 'pass');
});
