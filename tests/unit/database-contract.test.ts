import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { atodotrenGroupRoles, atodotrenRoles, privateSchemas } from '@atodotren/db';

void test('SQL migration and provider-neutral bootstrap agree with the TypeScript database contract', async () => {
  const [migration, bootstrap] = await Promise.all([
    readFile('migrations/0001_repository_foundation.sql', 'utf8'),
    readFile('docker/postgres/init/001-runtime-roles.sh', 'utf8'),
  ]);
  for (const role of atodotrenGroupRoles) {
    assert.match(migration, new RegExp(`'${role}'`, 'u'));
    assert.match(bootstrap, new RegExp(`'${role}'`, 'u'));
  }
  for (const schema of privateSchemas) {
    assert.match(migration, new RegExp(`\\b${schema}\\b`, 'u'));
  }
  assert.match(bootstrap, new RegExp(`GRANT ${atodotrenRoles.ingestWriter} TO ${atodotrenRoles.workerLogin}\\s+WITH ADMIN FALSE, INHERIT TRUE, SET FALSE`, 'u'));
  assert.match(bootstrap, new RegExp(`GRANT ${atodotrenRoles.migrationAdmin} TO ${atodotrenRoles.migratorLogin}\\s+WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`, 'u'));
});

void test('Compose forwards documented realtime operational thresholds', async () => {
  const compose = await readFile('compose.yaml', 'utf8');
  for (const [name, fallback] of [
    ['INGEST_ALERT_FAILURE_THRESHOLD', '3'],
    ['INGEST_STALE_AFTER_MS', '120000'],
    ['INGEST_MATCHING_RATE_MINIMUM', '0.02'],
    ['INGEST_MATCHING_RATE_RECOVERY_MINIMUM', '0.05'],
    ['INGEST_MATCHING_RECOVERY_THRESHOLD', '3'],
    ['INGEST_MALFORMED_RATE_MAXIMUM', '0.25'],
    ['SQLITE_SPOOL_WARNING_RATIO', '0.75'],
  ]) {
    assert.ok(compose.includes(`${name}: \${${name}:-${fallback}}`), `${name} is not forwarded by Compose`);
  }
});
