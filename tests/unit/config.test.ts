import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigError, loadConfig } from '@atodotren/config';

const validEnvironment = {
  DATABASE_URL: 'postgresql://worker:not-a-real-credential@localhost:5432/atodotren',
  NODE_ENV: 'test',
} as const;

void test('loads strict provider-neutral database defaults', () => {
  const config = loadConfig(validEnvironment);
  assert.equal(config.nodeEnvironment, 'test');
  assert.equal(config.database.url, validEnvironment.DATABASE_URL);
  assert.equal(config.migrationDatabase.url, validEnvironment.DATABASE_URL);
  assert.equal(config.database.poolMax, 5);
  assert.equal(config.database.sslMode, 'disable');
});

void test('rejects missing URLs, invalid integers, and unsafe TLS configuration together', () => {
  assert.throws(
    () =>
      loadConfig({
        DATABASE_POOL_MAX: '0',
        DATABASE_SSL_MODE: 'verify-full',
      }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.deepEqual(error.issues, [
        'DATABASE_URL is required',
        'DATABASE_SSL_MODE=verify-full requires DATABASE_CA_CERT_PATH',
        'DATABASE_POOL_MAX must be a positive integer',
      ]);
      assert.doesNotMatch(error.message, /password|secret/i);
      return true;
    },
  );
});

void test('accepts a separate migration URL without changing the runtime URL', () => {
  const config = loadConfig({
    ...validEnvironment,
    MIGRATION_DATABASE_URL: 'postgresql://admin:other@localhost:5432/atodotren',
  });
  assert.equal(config.database.url, validEnvironment.DATABASE_URL);
  assert.equal(
    config.migrationDatabase.url,
    'postgresql://admin:other@localhost:5432/atodotren',
  );
});

void test('validates matching alert hysteresis boundaries and consecutive recovery count', () => {
  const config = loadConfig(validEnvironment);
  assert.equal(config.operations.matchingRateMinimum, 0.02);
  assert.equal(config.operations.matchingRateRecoveryMinimum, 0.05);
  assert.equal(config.operations.matchingRecoveryThreshold, 3);
  assert.throws(
    () => loadConfig({
      ...validEnvironment,
      INGEST_MATCHING_RATE_MINIMUM: '0.05',
      INGEST_MATCHING_RATE_RECOVERY_MINIMUM: '0.02',
    }),
    (error: unknown) => error instanceof ConfigError && error.issues.includes(
      'INGEST_MATCHING_RATE_RECOVERY_MINIMUM must be greater than INGEST_MATCHING_RATE_MINIMUM',
    ),
  );
});

void test('migration URL falls back only when it is undefined', () => {
  assert.equal(loadConfig(validEnvironment).migrationDatabase.url, validEnvironment.DATABASE_URL);
  for (const value of ['', '   ', '\t']) {
    assert.throws(
      () => loadConfig({ ...validEnvironment, MIGRATION_DATABASE_URL: value }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.issues.includes('MIGRATION_DATABASE_URL is required'),
    );
  }
});

void test('rejects invalid and accepts valid explicit migration URLs', () => {
  assert.throws(
    () => loadConfig({ ...validEnvironment, MIGRATION_DATABASE_URL: 'https://example.test/db' }),
    ConfigError,
  );
  assert.equal(
    loadConfig({
      ...validEnvironment,
      MIGRATION_DATABASE_URL: 'postgres://migrator:value@localhost:5432/other',
    }).migrationDatabase.url,
    'postgres://migrator:value@localhost:5432/other',
  );
});
