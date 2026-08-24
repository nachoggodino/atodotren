import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { atodotrenGroupRoles, atodotrenRoles, privateSchemas } from '@atodotren/db';

void test('SQL migration and provider-neutral bootstrap agree with the TypeScript database contract', async () => {
  const [foundationMigration, reportingMigration, bootstrap] = await Promise.all([
    readFile('migrations/0001_repository_foundation.sql', 'utf8'),
    readFile('migrations/0009_reporting_telegram.sql', 'utf8'),
    readFile('docker/postgres/init/001-runtime-roles.sh', 'utf8'),
  ]);
  const migration = `${foundationMigration}
${reportingMigration}`;
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

void test('Compose forwards documented realtime and maintenance thresholds', async () => {
  const compose = await readFile('compose.yaml', 'utf8');
  assert.match(compose, /worker:\n[\s\S]*?command: \["ingest"\]/u);
  assert.match(compose, /maintenance:\n[\s\S]*?command: \["maintain"\]/u);
  assert.doesNotMatch(compose, /canonical-maintenance/u);
  for (const [name, fallback] of [
    ['INGEST_ALERT_FAILURE_THRESHOLD', '3'],
    ['INGEST_STALE_AFTER_MS', '120000'],
    ['INGEST_MATCHING_RATE_MINIMUM', '0.02'],
    ['INGEST_MATCHING_RATE_RECOVERY_MINIMUM', '0.05'],
    ['INGEST_MATCHING_RECOVERY_THRESHOLD', '3'],
    ['INGEST_MALFORMED_RATE_MAXIMUM', '0.25'],
    ['SQLITE_SPOOL_WARNING_RATIO', '0.75'],
    ['MAINTENANCE_INTERVAL_MS', '300000'],
    ['MAINTENANCE_FINALIZE_AFTER', '04:30'],
    ['MAINTENANCE_FINALIZE_BEFORE', '06:30'],
  ]) {
    assert.ok(compose.includes(`${name}: \${${name}:-${fallback}}`), `${name} is not forwarded by Compose`);
  }
});

void test('finalization correction stages one timetable expansion and preserves bounded eligibility exits', async () => {
  const migration = await readFile('migrations/0011_isolated_maintenance_finalization.sql', 'utf8');
  assert.equal((migration.match(/operations\.expected_timetable_stop\(target_date\)/gu) ?? []).length, 1);
  assert.match(migration, /CREATE TEMP TABLE atodotren_expected_timetable_stop ON COMMIT DROP/u);
  assert.match(migration, /ANALYZE atodotren_expected_timetable_stop/u);
  assert.match(migration, /status', 'already_finalized'/u);
  assert.match(migration, /service_day_grace_not_elapsed/u);
});
