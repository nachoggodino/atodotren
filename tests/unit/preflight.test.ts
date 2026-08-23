import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateDiskSpace,
  evaluatePrimaryPostgres,
  evaluateTelegramRoleContract,
  inspectLocalEnvironment,
  parseEnvironmentFile,
  preflightExitCode,
} from '@atodotren/config';

const localEnvironment = {
  POSTGRES_DB: 'atodotren',
  POSTGRES_USER: 'postgres',
  POSTGRES_PASSWORD: 'admin-test-value',
  ATODOTREN_WORKER_PASSWORD: 'worker-test-value',
  ATODOTREN_TELEGRAM_PASSWORD: 'telegram-test-value',
  POSTGRES_PORT: '5432',
  DATABASE_URL: 'postgresql://atodotren_worker:worker-test-value@localhost:5432/atodotren',
  MIGRATION_DATABASE_URL:
    'postgresql://atodotren_migrator:admin-test-value@localhost:5432/atodotren',
  REPORT_DATABASE_URL:
    'postgresql://atodotren_telegram:telegram-test-value@localhost:5432/atodotren',
  TEST_ADMIN_DATABASE_URL: 'postgresql://postgres:admin-test-value@localhost:5432/atodotren',
  TEST_MIGRATOR_DATABASE_URL:
    'postgresql://atodotren_migrator:admin-test-value@localhost:5432/atodotren',
  TEST_WORKER_DATABASE_URL:
    'postgresql://atodotren_worker:worker-test-value@localhost:5432/atodotren',
  TEST_TELEGRAM_DATABASE_URL:
    'postgresql://atodotren_telegram:telegram-test-value@localhost:5432/atodotren',
} as const;

void test('parses quoted environment values without evaluating shell syntax', () => {
  assert.deepEqual(parseEnvironmentFile("A=plain\nB='quoted value'\n# ignored\nC=\"other\"\n"), {
    A: 'plain',
    B: 'quoted value',
    C: 'other',
  });
});

void test('accepts a coherent local PostgreSQL environment including Telegram reporting URLs', () => {
  const checks = inspectLocalEnvironment(localEnvironment);
  assert.equal(preflightExitCode(checks), 0);
  assert.ok(checks.every((check) => check.status === 'pass'));
});

void test('rejects placeholders and component-password drift without exposing values', () => {
  const checks = inspectLocalEnvironment({
    ...localEnvironment,
    ATODOTREN_TELEGRAM_PASSWORD: 'change-me',
    REPORT_DATABASE_URL:
      'postgresql://atodotren_telegram:stale-test-value@localhost:5432/atodotren',
  });
  assert.equal(preflightExitCode(checks), 1);
  assert.equal(checks.find((check) => check.name === 'environment.placeholders')?.status, 'fail');
  assert.equal(checks.find((check) => check.name === 'database.password-coherence')?.status, 'fail');
  const output = JSON.stringify(checks);
  assert.doesNotMatch(output, /change-me|stale-test-value/u);
});

void test('rejects an absent required Telegram database URL', () => {
  const incompleteEnvironment: Record<string, string | undefined> = { ...localEnvironment };
  delete incompleteEnvironment.TEST_TELEGRAM_DATABASE_URL;
  const checks = inspectLocalEnvironment(incompleteEnvironment);
  assert.equal(preflightExitCode(checks), 1);
  assert.match(
    checks.find((check) => check.name === 'environment.required')?.message ?? '',
    /TEST_TELEGRAM_DATABASE_URL/u,
  );
});

void test('Telegram reporting role contract requires exact sole direct membership', () => {
  const exact = evaluateTelegramRoleContract({
    currentUser: 'atodotren_telegram',
    loginExists: true,
    loginUnsafe: false,
    reportingRoleExists: true,
    reportingRoleUnsafe: false,
    directMemberships: [{ role: 'atodotren_reporting_reader', admin: false, inherit: true, set: false }],
  });
  assert.equal(exact.status, 'pass');
  const drift = evaluateTelegramRoleContract({
    currentUser: 'atodotren_telegram',
    loginExists: true,
    loginUnsafe: false,
    reportingRoleExists: true,
    reportingRoleUnsafe: false,
    directMemberships: [
      { role: 'atodotren_reporting_reader', admin: false, inherit: true, set: false },
      { role: 'atodotren_monitor_reader', admin: false, inherit: true, set: false },
    ],
  });
  assert.equal(drift.status, 'fail');
});

void test('blocking failures produce a nonzero exit and disk thresholds are deterministic', () => {
  assert.equal(preflightExitCode([{ name: 'x', status: 'fail', message: 'blocked' }]), 1);
  assert.equal(evaluateDiskSpace(1 * 1024 ** 3).status, 'fail');
  assert.equal(evaluateDiskSpace(5 * 1024 ** 3).status, 'warn');
  assert.equal(evaluateDiskSpace(12 * 1024 ** 3).status, 'pass');
});

void test('primary PostgreSQL binding checks distinguish matching, mismatched, and unrelated listeners', () => {
  const matching = evaluatePrimaryPostgres(
    { exists: true, running: true, health: 'healthy', hostPorts: [5432, 5432] },
    5432,
    true,
  );
  assert.equal(preflightExitCode(matching), 0);
  const mismatched = evaluatePrimaryPostgres(
    { exists: true, running: true, health: 'healthy', hostPorts: [55432] },
    5432,
    true,
  );
  assert.equal(preflightExitCode(mismatched), 1);
  assert.match(mismatched.find((check) => check.name === 'postgres.port-binding')?.message ?? '', /does not match/u);
  const absentWithListener = evaluatePrimaryPostgres(
    { exists: false, running: false, health: 'absent', hostPorts: [] },
    5432,
    true,
  );
  assert.equal(preflightExitCode(absentWithListener), 1);
  assert.match(absentWithListener.at(-1)?.message ?? '', /unrelated listener/u);
});

void test('primary PostgreSQL checks distinguish no binding and unhealthy state', () => {
  const checks = evaluatePrimaryPostgres(
    { exists: true, running: true, health: 'unhealthy', hostPorts: [] },
    5432,
    false,
  );
  assert.equal(preflightExitCode(checks), 1);
  assert.match(checks[0]?.message ?? '', /unhealthy/u);
  assert.match(checks[1]?.message ?? '', /no published/u);
});
