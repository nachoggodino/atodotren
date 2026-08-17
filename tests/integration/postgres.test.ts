import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { migrateToLatest } from '@atodotren/db';
import { importStaticFeed, renfeMadridMapping } from '@atodotren/gtfs-static';
import { Client, Pool } from 'pg';

import { createFixtureZip, createStoredZip } from '../helpers/zip.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is required; integration tests never skip unavailable PostgreSQL`,
    );
  }
  return value;
}

function withDatabase(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const databaseName = `atodotren_test_${process.pid}_${Date.now()}`;
const adminBaseUrl = requiredEnvironment('TEST_ADMIN_DATABASE_URL');
const migratorBaseUrl = requiredEnvironment('TEST_MIGRATOR_DATABASE_URL');
const workerBaseUrl = requiredEnvironment('TEST_WORKER_DATABASE_URL');
const adminDatabaseUrl = withDatabase(adminBaseUrl, databaseName);
const migratorDatabaseUrl = withDatabase(migratorBaseUrl, databaseName);
const workerDatabaseUrl = withDatabase(workerBaseUrl, databaseName);

const baseConnectionOptions = {
  sslMode: 'disable' as const,
  poolMax: 2,
  connectionTimeoutMs: 5_000,
  idleTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
};
const representativeFixtureDirectory = resolve('tests/fixtures/gtfs-static/representative');
const fixtureMapping = {
  ...renfeMadridMapping,
  canaries: {
    requiredLineCodes: ['C-1'],
    requiredStationPublicIds: ['atocha', 'aeropuerto-t4'],
    minimumStations: 3,
    minimumTrips: 1,
    requireReferencedShapes: true,
  },
};

async function copyCurrentMigrations(directory: string): Promise<void> {
  await Promise.all([
    cp(
      resolve(process.cwd(), 'migrations/0001_repository_foundation.sql'),
      join(directory, '0001_repository_foundation.sql'),
    ),
    cp(
      resolve(process.cwd(), 'migrations/0002_static_madrid_foundation.sql'),
      join(directory, '0002_static_madrid_foundation.sql'),
    ),
    cp(
      resolve(process.cwd(), 'migrations/0003_static_mapping_integrity.sql'),
      join(directory, '0003_static_mapping_integrity.sql'),
    ),
  ]);
}

async function runWorkerDoctor(
  migrationsDirectory = resolve(process.cwd(), 'migrations'),
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['apps/worker/dist/cli.js', 'doctor'], {
    cwd: process.cwd(),
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DATABASE_URL: workerDatabaseUrl,
      DATABASE_SSL_MODE: 'disable',
      MIGRATIONS_DIR: migrationsDirectory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  await once(child, 'close');
  return { code: child.exitCode, stdout, stderr };
}

void test('empty PostgreSQL migration, idempotency, permissions, and worker doctor', async (t) => {
  const admin = new Client({ connectionString: adminBaseUrl });
  let rotatedLogin: string | undefined;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const databaseBootstrap = new Client({ connectionString: adminDatabaseUrl });
    await databaseBootstrap.connect();
    try {
      await databaseBootstrap.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await databaseBootstrap.query(
        `GRANT CREATE ON DATABASE ${databaseName} TO atodotren_migration_admin`,
      );
    } finally {
      await databaseBootstrap.end();
    }

    await t.test('rejects every unsafe attribute on an existing project role', async () => {
      const unsafeAttributes = [
        ['LOGIN', 'NOLOGIN'],
        ['SUPERUSER', 'NOSUPERUSER'],
        ['CREATEDB', 'NOCREATEDB'],
        ['CREATEROLE', 'NOCREATEROLE'],
        ['REPLICATION', 'NOREPLICATION'],
        ['BYPASSRLS', 'NOBYPASSRLS'],
      ] as const;

      for (const [unsafeAttribute, safeAttribute] of unsafeAttributes) {
        await admin.query(`ALTER ROLE atodotren_web_reader ${unsafeAttribute}`);
        try {
          await assert.rejects(
            migrateToLatest({
              connection: {
                ...baseConnectionOptions,
                url: migratorDatabaseUrl,
                applicationName: `atodotren-integration-unsafe-${unsafeAttribute.toLowerCase()}`,
              },
              migrationsDirectory: resolve(process.cwd(), 'migrations'),
            }),
            /unsafe attributes/,
          );
        } finally {
          await admin.query(`ALTER ROLE atodotren_web_reader ${safeAttribute}`);
        }
      }
    });

    await t.test('migrates an empty stock PostgreSQL database', async () => {
      const result = await migrateToLatest({
        connection: {
          ...baseConnectionOptions,
          url: migratorDatabaseUrl,
          applicationName: 'atodotren-integration-migrate',
        },
        migrationsDirectory: resolve(process.cwd(), 'migrations'),
      });
      assert.deepEqual(result.applied, [
        '0001_repository_foundation.sql',
        '0002_static_madrid_foundation.sql',
        '0003_static_mapping_integrity.sql',
      ]);
      assert.deepEqual(result.alreadyApplied, []);
    });

    await t.test('second migration run is clean and applies nothing', async () => {
      const result = await migrateToLatest({
        connection: {
          ...baseConnectionOptions,
          url: migratorDatabaseUrl,
          applicationName: 'atodotren-integration-remigrate',
        },
        migrationsDirectory: resolve(process.cwd(), 'migrations'),
      });
      assert.deepEqual(result.applied, []);
      assert.deepEqual(result.alreadyApplied, [
        '0001_repository_foundation.sql',
        '0002_static_madrid_foundation.sql',
        '0003_static_mapping_integrity.sql',
      ]);
    });

    await t.test('static schema is network-aware, version-scoped, indexed, and least-privilege', async () => {
      const migratedAdmin = new Client({ connectionString: adminDatabaseUrl });
      await migratedAdmin.connect();
      try {
        const madrid = await migratedAdmin.query<{
          slug: string;
          timezone: string;
          active: boolean;
        }>("SELECT slug, timezone, is_active AS active FROM core.network WHERE slug = 'madrid'");
        assert.deepEqual(madrid.rows, [
          { slug: 'madrid', timezone: 'Europe/Madrid', active: true },
        ]);

        const missingIndexes = await migratedAdmin.query<{ relation_name: string; constraint_name: string }>(`
          SELECT
            constraint_relation::regclass::text AS relation_name,
            constraint_name
          FROM (
            SELECT
              constraint_row.conrelid AS constraint_relation,
              constraint_row.conname AS constraint_name,
              constraint_row.conkey AS constraint_columns
            FROM pg_constraint AS constraint_row
            JOIN pg_namespace AS namespace ON namespace.oid = constraint_row.connamespace
            WHERE constraint_row.contype = 'f'
              AND namespace.nspname IN ('core', 'gtfs_static')
          ) AS foreign_keys
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_index AS index_row
            WHERE index_row.indrelid = constraint_relation
              AND index_row.indisvalid
              AND (index_row.indkey::smallint[])[0:cardinality(constraint_columns) - 1] = constraint_columns
          )
          ORDER BY relation_name, constraint_name
        `);
        assert.deepEqual(missingIndexes.rows, []);

        const permissions = await migratedAdmin.query<{
          worker_feed_insert: boolean;
          worker_fact_insert: boolean;
          worker_fact_update: boolean;
          worker_fact_delete: boolean;
          worker_network_insert: boolean;
          web_static_select: boolean;
          backup_static_select: boolean;
          monitor_active_select: boolean;
        }>(`
          SELECT
            has_table_privilege('atodotren_ingest_writer', 'gtfs_static.feed_version', 'INSERT') AS worker_feed_insert,
            has_table_privilege('atodotren_ingest_writer', 'gtfs_static.stop_time', 'INSERT') AS worker_fact_insert,
            has_table_privilege('atodotren_ingest_writer', 'gtfs_static.stop_time', 'UPDATE') AS worker_fact_update,
            has_table_privilege('atodotren_ingest_writer', 'gtfs_static.stop_time', 'DELETE') AS worker_fact_delete,
            has_table_privilege('atodotren_ingest_writer', 'core.network', 'INSERT') AS worker_network_insert,
            has_table_privilege('atodotren_web_reader', 'gtfs_static.stop_time', 'SELECT') AS web_static_select,
            has_table_privilege('atodotren_backup_reader', 'gtfs_static.stop_time', 'SELECT') AS backup_static_select,
            has_table_privilege('atodotren_monitor_reader', 'gtfs_static.current_feed_version', 'SELECT') AS monitor_active_select
        `);
        assert.deepEqual(permissions.rows[0], {
          worker_feed_insert: true,
          worker_fact_insert: true,
          worker_fact_update: false,
          worker_fact_delete: false,
          worker_network_insert: false,
          web_static_select: false,
          backup_static_select: true,
          monitor_active_select: true,
        });
      } finally {
        await migratedAdmin.end();
      }
    });

    await t.test('migration validation rejects an unexpected migrator membership', async () => {
      const extraRole = `atodotren_test_migrator_extra_${process.pid}`;
      await admin.query(`CREATE ROLE ${extraRole} NOLOGIN`);
      try {
        await admin.query(
          `GRANT ${extraRole} TO atodotren_migrator WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
        );
        await assert.rejects(
          migrateToLatest({
            connection: {
              ...baseConnectionOptions,
              url: migratorDatabaseUrl,
              applicationName: 'atodotren-integration-extra-migrator-role',
            },
            migrationsDirectory: resolve(process.cwd(), 'migrations'),
          }),
          /exact required membership/u,
        );
      } finally {
        await admin.query(`REVOKE ${extraRole} FROM atodotren_migrator`);
        await admin.query(`DROP ROLE ${extraRole}`);
      }
    });

    await t.test('checksum mismatch and missing applied migration are rejected', async () => {
      const migratedAdmin = new Client({ connectionString: adminDatabaseUrl });
      await migratedAdmin.connect();
      const temporaryMigrations = await mkdtemp(join(tmpdir(), 'atodotren-missing-'));
      try {
        await migratedAdmin.query(
          "UPDATE operations.schema_migration SET checksum = repeat('0', 64) WHERE name = '0001_repository_foundation.sql'",
        );
        await assert.rejects(
          migrateToLatest({
            connection: { ...baseConnectionOptions, url: migratorDatabaseUrl, applicationName: 'atodotren-checksum-mismatch' },
            migrationsDirectory: resolve(process.cwd(), 'migrations'),
          }),
          /has been modified/u,
        );
        await migratedAdmin.query(
          "UPDATE operations.schema_migration SET checksum = '13ff887ab7942ba53322d85e33e7ea28280dc29006257ddfb36a3e352274132c' WHERE name = '0001_repository_foundation.sql'",
        );
        await writeFile(join(temporaryMigrations, '0009_only.sql'), 'SELECT 9;\n');
        await assert.rejects(
          migrateToLatest({
            connection: { ...baseConnectionOptions, url: migratorDatabaseUrl, applicationName: 'atodotren-missing-applied' },
            migrationsDirectory: temporaryMigrations,
          }),
          /missing from the repository/u,
        );
      } finally {
        await migratedAdmin.query(
          "UPDATE operations.schema_migration SET checksum = '13ff887ab7942ba53322d85e33e7ea28280dc29006257ddfb36a3e352274132c' WHERE name = '0001_repository_foundation.sql'",
        );
        await migratedAdmin.end();
        await rm(temporaryMigrations, { recursive: true, force: true });
      }
    });

    await t.test('failed migration rolls back and releases its advisory lock', async () => {
      const temporaryMigrations = await mkdtemp(join(tmpdir(), 'atodotren-rollback-'));
      const migratedAdmin = new Client({ connectionString: adminDatabaseUrl });
      await migratedAdmin.connect();
      try {
        await copyCurrentMigrations(temporaryMigrations);
        await writeFile(
          join(temporaryMigrations, '9000_rollback_probe.sql'),
          'CREATE TABLE operations.rollback_probe (id integer);\nSELECT definitely_invalid_syntax;\n',
        );
        await assert.rejects(
          migrateToLatest({
            connection: { ...baseConnectionOptions, url: migratorDatabaseUrl, applicationName: 'atodotren-rollback' },
            migrationsDirectory: temporaryMigrations,
          }),
        );
        const state = await migratedAdmin.query<{ table_exists: boolean; ledger_exists: boolean; lock_acquired: boolean }>(`
          SELECT
            to_regclass('operations.rollback_probe') IS NOT NULL AS table_exists,
            EXISTS (SELECT 1 FROM operations.schema_migration WHERE name = '9000_rollback_probe.sql') AS ledger_exists,
            pg_try_advisory_lock(7811417130112024::bigint) AS lock_acquired
        `);
        assert.deepEqual(state.rows[0], { table_exists: false, ledger_exists: false, lock_acquired: true });
        await migratedAdmin.query('SELECT pg_advisory_unlock(7811417130112024::bigint)');
      } finally {
        await migratedAdmin.end();
        await rm(temporaryMigrations, { recursive: true, force: true });
      }
    });

    await t.test('two concurrent migration attempts serialize and preserve owner context', async () => {
      const temporaryMigrations = await mkdtemp(join(tmpdir(), 'atodotren-concurrent-'));
      const migratedAdmin = new Client({ connectionString: adminDatabaseUrl });
      await migratedAdmin.connect();
      try {
        await copyCurrentMigrations(temporaryMigrations);
        await writeFile(
          join(temporaryMigrations, '9001_concurrent_probe.sql'),
          'SELECT pg_sleep(0.25);\nCREATE TABLE api.concurrent_probe (id bigint PRIMARY KEY);\n',
        );
        const run = (applicationName: string) => migrateToLatest({
          connection: { ...baseConnectionOptions, url: migratorDatabaseUrl, applicationName },
          migrationsDirectory: temporaryMigrations,
        });
        const results = await Promise.all([run('atodotren-concurrent-a'), run('atodotren-concurrent-b')]);
        assert.equal(results.filter((result) => result.applied.includes('9001_concurrent_probe.sql')).length, 1);
        assert.equal(results.filter((result) => result.alreadyApplied.includes('9001_concurrent_probe.sql')).length, 1);
        const ownership = await migratedAdmin.query<{ owner: string }>(
          "SELECT tableowner AS owner FROM pg_tables WHERE schemaname = 'api' AND tablename = 'concurrent_probe'",
        );
        assert.equal(ownership.rows[0]?.owner, 'atodotren_migration_admin');
      } finally {
        await migratedAdmin.query('DROP TABLE IF EXISTS api.concurrent_probe');
        await migratedAdmin.query("DELETE FROM operations.schema_migration WHERE name = '9001_concurrent_probe.sql'");
        await migratedAdmin.end();
        await rm(temporaryMigrations, { recursive: true, force: true });
      }
    });

    await t.test('runtime role can read approved health objects but cannot create schemas', async () => {
      const worker = new Client({ connectionString: workerDatabaseUrl });
      await worker.connect();
      try {
        const permissions = await worker.query<{
          is_writer: boolean;
          core_usage: boolean;
          core_create: boolean;
          api_usage: boolean;
          public_usage: boolean;
          public_create: boolean;
        }>(`
          SELECT
            pg_has_role(current_user, 'atodotren_ingest_writer', 'member') AS is_writer,
            has_schema_privilege(current_user, 'core', 'USAGE') AS core_usage,
            has_schema_privilege(current_user, 'core', 'CREATE') AS core_create,
            has_schema_privilege(current_user, 'api', 'USAGE') AS api_usage,
            has_schema_privilege(current_user, 'public', 'USAGE') AS public_usage,
            has_schema_privilege(current_user, 'public', 'CREATE') AS public_create
        `);
        assert.deepEqual(permissions.rows[0], {
          is_writer: true,
          core_usage: true,
          core_create: false,
          api_usage: false,
          public_usage: false,
          public_create: false,
        });
        const health = await worker.query('SELECT checked_at FROM operations.database_health');
        assert.equal(health.rowCount, 1);
        await assert.rejects(worker.query('CREATE TABLE core.forbidden (id integer)'));
      } finally {
        await worker.end();
      }
    });

    await t.test('all group roles have safe attributes and keep their schema boundaries', async () => {
      const migratedAdmin = new Client({ connectionString: adminDatabaseUrl });
      await migratedAdmin.connect();
      try {
        const roles = await migratedAdmin.query<{
          rolname: string;
          rolcanlogin: boolean;
          rolsuper: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolreplication: boolean;
          rolbypassrls: boolean;
        }>(`
          SELECT
            rolname,
            rolcanlogin,
            rolsuper,
            rolcreatedb,
            rolcreaterole,
            rolreplication,
            rolbypassrls
          FROM pg_roles
          WHERE rolname = ANY(ARRAY[
            'atodotren_migration_admin',
            'atodotren_ingest_writer',
            'atodotren_web_reader',
            'atodotren_backup_reader',
            'atodotren_monitor_reader'
          ])
          ORDER BY rolname
        `);
        assert.equal(roles.rowCount, 5);
        assert.ok(
          roles.rows.every(
            (role) =>
              !role.rolcanlogin &&
              !role.rolsuper &&
              !role.rolcreatedb &&
              !role.rolcreaterole &&
              !role.rolreplication &&
              !role.rolbypassrls,
          ),
        );

        const boundaries = await migratedAdmin.query<{
          web_api_usage: boolean;
          web_core_usage: boolean;
          monitor_operations_usage: boolean;
          monitor_core_usage: boolean;
        }>(`
          SELECT
            has_schema_privilege('atodotren_web_reader', 'api', 'USAGE') AS web_api_usage,
            has_schema_privilege('atodotren_web_reader', 'core', 'USAGE') AS web_core_usage,
            has_schema_privilege('atodotren_monitor_reader', 'operations', 'USAGE') AS monitor_operations_usage,
            has_schema_privilege('atodotren_monitor_reader', 'core', 'USAGE') AS monitor_core_usage
        `);
        assert.deepEqual(boundaries.rows[0], {
          web_api_usage: true,
          web_core_usage: false,
          monitor_operations_usage: true,
          monitor_core_usage: false,
        });
      } finally {
        await migratedAdmin.end();
      }
    });

    await t.test('migration and runtime memberships use constrained PostgreSQL 16+ options', async () => {
      const migratedAdmin = new Client({ connectionString: adminDatabaseUrl });
      await migratedAdmin.connect();
      try {
        const memberships = await migratedAdmin.query<{
          granted_role: string;
          member_role: string;
          admin_option: boolean;
          inherit_option: boolean;
          set_option: boolean;
        }>(`
          SELECT
            granted_role.rolname AS granted_role,
            member_role.rolname AS member_role,
            membership.admin_option,
            membership.inherit_option,
            membership.set_option
          FROM pg_auth_members membership
          JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
          JOIN pg_roles member_role ON member_role.oid = membership.member
          WHERE (granted_role.rolname, member_role.rolname) IN (
            ('atodotren_ingest_writer', 'atodotren_worker'),
            ('atodotren_migration_admin', 'atodotren_migrator')
          )
          ORDER BY granted_role.rolname
        `);
        assert.deepEqual(memberships.rows, [
          {
            granted_role: 'atodotren_ingest_writer',
            member_role: 'atodotren_worker',
            admin_option: false,
            inherit_option: true,
            set_option: false,
          },
          {
            granted_role: 'atodotren_migration_admin',
            member_role: 'atodotren_migrator',
            admin_option: false,
            inherit_option: false,
            set_option: true,
          },
        ]);
      } finally {
        await migratedAdmin.end();
      }
    });

    await t.test('a rotated migration login preserves ownership and default privileges', async () => {
      rotatedLogin = `atodotren_migrator_${process.pid}_${Date.now()}`;
      const rotatedPassword = 'local-contract-rotation-password';
      const rotatedUrl = new URL(adminDatabaseUrl);
      rotatedUrl.username = rotatedLogin;
      rotatedUrl.password = rotatedPassword;

      await admin.query(
        `CREATE ROLE ${rotatedLogin} LOGIN NOINHERIT PASSWORD '${rotatedPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );

      const temporaryMigrations = await mkdtemp(join(tmpdir(), 'atodotren-migrations-'));
      try {
        await copyCurrentMigrations(temporaryMigrations);
        await writeFile(
          join(temporaryMigrations, '9002_rotation_probe.sql'),
          'CREATE TABLE api.rotation_probe (id bigint PRIMARY KEY);\n',
          'utf8',
        );

        await assert.rejects(
          migrateToLatest({
            connection: {
              ...baseConnectionOptions,
              url: rotatedUrl.toString(),
              applicationName: 'atodotren-integration-ungranted-rotation',
            },
            migrationsDirectory: temporaryMigrations,
          }),
          /exact required membership/,
        );

        await admin.query(
          `GRANT atodotren_migration_admin TO ${rotatedLogin} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
        );
        const result = await migrateToLatest({
          connection: {
            ...baseConnectionOptions,
            url: rotatedUrl.toString(),
            applicationName: 'atodotren-integration-rotated-migrator',
          },
          migrationsDirectory: temporaryMigrations,
        });
        assert.deepEqual(result.applied, ['9002_rotation_probe.sql']);
        assert.deepEqual(result.alreadyApplied, [
          '0001_repository_foundation.sql',
          '0002_static_madrid_foundation.sql',
          '0003_static_mapping_integrity.sql',
        ]);

        const migratedAdmin = new Client({ connectionString: adminDatabaseUrl });
        await migratedAdmin.connect();
        try {
          const ownership = await migratedAdmin.query<{
            table_owner: string;
            web_can_select: boolean;
            backup_can_select: boolean;
            worker_can_select: boolean;
          }>(`
            SELECT
              tableowner AS table_owner,
              has_table_privilege('atodotren_web_reader', 'api.rotation_probe', 'SELECT') AS web_can_select,
              has_table_privilege('atodotren_backup_reader', 'api.rotation_probe', 'SELECT') AS backup_can_select,
              has_table_privilege('atodotren_ingest_writer', 'api.rotation_probe', 'SELECT') AS worker_can_select
            FROM pg_tables
            WHERE schemaname = 'api' AND tablename = 'rotation_probe'
          `);
          assert.deepEqual(ownership.rows[0], {
            table_owner: 'atodotren_migration_admin',
            web_can_select: true,
            backup_can_select: true,
            worker_can_select: false,
          });
          await migratedAdmin.query('DROP TABLE api.rotation_probe');
          await migratedAdmin.query(
            "DELETE FROM operations.schema_migration WHERE name = '9002_rotation_probe.sql'",
          );
        } finally {
          await migratedAdmin.end();
        }
      } finally {
        await rm(temporaryMigrations, { recursive: true, force: true });
      }
    });

    await t.test('doctor reports the precise missing-active-static state', async () => {
      const result = await runWorkerDoctor();
      assert.equal(result.code, 1);
      assert.match(result.stdout, /No valid active Madrid static-feed version exists/u);
      assert.match(result.stdout, /worker import-static/u);
    });

    await t.test('fixture import is Madrid-only, idempotent, transactional, versioned, and serialized', async () => {
      const directory = await mkdtemp('/tmp/atodotren-static-integration-');
      const pool = new Pool({ connectionString: workerDatabaseUrl, max: 4 });
      const migratedAdmin = new Client({ connectionString: adminDatabaseUrl });
      await migratedAdmin.connect();
      const fixtureNames = ['agency.txt', 'routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'calendar.txt', 'shapes.txt'];
      const fixtureEntries = async (overrides: Readonly<Record<string, string>> = {}) => Promise.all(
        fixtureNames.map(async (name) => ({
          name,
          data: overrides[name] ?? await readFile(join(representativeFixtureDirectory, name), 'utf8'),
        })),
      );
      try {
        const firstPath = join(directory, 'representative-v1.zip');
        await writeFile(firstPath, await createFixtureZip(representativeFixtureDirectory));
        const first = await importStaticFeed({
          pool,
          source: { kind: 'file', path: firstPath },
          mapping: fixtureMapping,
          temporaryDirectory: directory,
        });
        assert.equal(first.ok, true, JSON.stringify(first));
        assert.equal(first.result, 'imported');
        assert.equal(first.retained?.stopTimes, 4);
        const firstId = first.feedVersionId;
        assert.ok(firstId !== undefined);

        const persisted = await migratedAdmin.query<{
          routes: string;
          trips: string;
          stops: string;
          stop_times: string;
          non_madrid: string;
          patterns: string;
          ordered_stops: string;
          segments: string;
          shapes: string;
          maximum_time: number;
        }>(`
          SELECT
            (SELECT count(*) FROM gtfs_static.route WHERE feed_version_id = $1)::text AS routes,
            (SELECT count(*) FROM gtfs_static.trip WHERE feed_version_id = $1)::text AS trips,
            (SELECT count(*) FROM gtfs_static.stop WHERE feed_version_id = $1)::text AS stops,
            (SELECT count(*) FROM gtfs_static.stop_time WHERE feed_version_id = $1)::text AS stop_times,
            (SELECT count(*) FROM gtfs_static.route WHERE feed_version_id = $1 AND route_id LIKE '20%')::text AS non_madrid,
            (SELECT count(*) FROM gtfs_static.trip_pattern_map WHERE feed_version_id = $1)::text AS patterns,
            (SELECT count(*) FROM core.service_pattern_stop)::text AS ordered_stops,
            (SELECT count(*) FROM core.segment)::text AS segments,
            (SELECT count(*) FROM gtfs_static.shape WHERE feed_version_id = $1)::text AS shapes,
            (SELECT max(arrival_seconds) FROM gtfs_static.stop_time WHERE feed_version_id = $1)::integer AS maximum_time
        `, [firstId]);
        assert.deepEqual(persisted.rows[0], {
          routes: '1', trips: '1', stops: '3', stop_times: '4', non_madrid: '0',
          patterns: '1', ordered_stops: '3', segments: '2', shapes: '1', maximum_time: 90_960,
        });
        await assert.rejects(
          migratedAdmin.query("UPDATE gtfs_static.stop SET stop_name = 'mutated' WHERE feed_version_id = $1", [firstId]),
          /immutable/u,
        );
        await assert.rejects(
          migratedAdmin.query("UPDATE gtfs_static.feed_version SET import_report = '{}'::jsonb WHERE id = $1", [firstId]),
          /immutable/u,
        );

        const same = await importStaticFeed({
          pool,
          source: { kind: 'file', path: firstPath },
          mapping: fixtureMapping,
          temporaryDirectory: directory,
        });
        assert.equal(same.result, 'unchanged');
        assert.equal(same.feedVersionId, firstId);

        const secondPath = join(directory, 'representative-v2.zip');
        const shapes = await readFile(join(representativeFixtureDirectory, 'shapes.txt'), 'utf8');
        await writeFile(secondPath, createStoredZip(await fixtureEntries({ 'shapes.txt': `${shapes}\n` })));
        const second = await importStaticFeed({
          pool,
          source: { kind: 'file', path: secondPath },
          mapping: fixtureMapping,
          temporaryDirectory: directory,
        });
        assert.equal(second.result, 'imported', JSON.stringify(second));
        assert.equal(second.previousVersionId, firstId);
        const secondId = second.feedVersionId;
        assert.ok(secondId !== undefined);

        const thirdPath = join(directory, 'representative-v3.zip');
        await writeFile(thirdPath, createStoredZip(await fixtureEntries({ 'shapes.txt': `${shapes}\n\n` })));
        const concurrent = await Promise.all([
          importStaticFeed({ pool, source: { kind: 'file', path: thirdPath }, mapping: fixtureMapping, temporaryDirectory: directory }),
          importStaticFeed({ pool, source: { kind: 'file', path: thirdPath }, mapping: fixtureMapping, temporaryDirectory: directory }),
        ]);
        assert.deepEqual(concurrent.map((report) => report.result).sort(), ['imported', 'unchanged']);
        const thirdId = concurrent.find((report) => report.result === 'imported')?.feedVersionId;
        assert.ok(thirdId !== undefined);

        const invalidPath = join(directory, 'representative-invalid.zip');
        const invalidShapes = shapes.split('\n').filter((line) => !line.startsWith('10SHAPE-A')).join('\n');
        await writeFile(invalidPath, createStoredZip(await fixtureEntries({ 'shapes.txt': invalidShapes })));
        const rejected = await importStaticFeed({
          pool,
          source: { kind: 'file', path: invalidPath },
          mapping: fixtureMapping,
          temporaryDirectory: directory,
        });
        assert.equal(rejected.result, 'rejected');
        assert.equal(rejected.feedVersionStatus, 'rejected');

        await migratedAdmin.query(`
          INSERT INTO core.station (network_id, public_id, slug_es, slug_en, name_es, name_en)
          SELECT id, 'collision-owner', 'atocha-collision', 'atocha-collision', 'Collision', 'Collision'
          FROM core.network WHERE slug = 'madrid'
        `);
        const stops = await readFile(join(representativeFixtureDirectory, 'stops.txt'), 'utf8');
        const collisionStops = stops.replace('10STOP-A,atocha,', '10STOP-A,atocha-collision,');
        const databaseFailurePath = join(directory, 'representative-db-failure.zip');
        await writeFile(databaseFailurePath, createStoredZip(await fixtureEntries({ 'stops.txt': collisionStops })));
        const databaseFailure = await importStaticFeed({
          pool,
          source: { kind: 'file', path: databaseFailurePath },
          mapping: { ...fixtureMapping, canaries: { ...fixtureMapping.canaries, requiredStationPublicIds: [] } },
          temporaryDirectory: directory,
        });
        assert.equal(databaseFailure.result, 'rejected');
        assert.equal(databaseFailure.error?.kind, 'database');
        await migratedAdmin.query("DELETE FROM core.station WHERE public_id = 'collision-owner'");

        const state = await migratedAdmin.query<{
          active_id: string;
          previous_id: string | null;
          active_count: string;
          rejected_fact_count: string;
        }>(`
          SELECT
            active.id AS active_id,
            active.previous_feed_version_id AS previous_id,
            (SELECT count(*) FROM gtfs_static.feed_version WHERE status = 'active')::text AS active_count,
            (SELECT count(*) FROM gtfs_static.stop AS stop
             JOIN gtfs_static.feed_version AS version ON version.id = stop.feed_version_id
             WHERE version.status = 'rejected')::text AS rejected_fact_count
          FROM gtfs_static.feed_version AS active WHERE active.status = 'active'
        `);
        assert.deepEqual(state.rows[0], {
          active_id: thirdId,
          previous_id: secondId,
          active_count: '1',
          rejected_fact_count: '0',
        });
      } finally {
        await migratedAdmin.end();
        await pool.end();
        await rm(directory, { recursive: true, force: true });
      }
    });

    await t.test('static mapping integrity accepts matching dimensions and rejects contradictions', async () => {
      const migratedAdmin = new Client({ connectionString: adminDatabaseUrl });
      await migratedAdmin.connect();
      try {
        await migratedAdmin.query('BEGIN');
        const stable = await migratedAdmin.query<{
          network_id: string;
          station_id: string;
          line_id: string;
          branch_id: string;
          service_pattern_id: string;
          active_version_id: string;
        }>(`
          SELECT version.network_id, stop_map.station_id, route_map.line_id,
                 trip_map.branch_id, trip_map.service_pattern_id, version.id AS active_version_id
          FROM gtfs_static.feed_version AS version
          JOIN gtfs_static.stop_station_map AS stop_map ON stop_map.feed_version_id = version.id
          JOIN gtfs_static.route_line_map AS route_map ON route_map.feed_version_id = version.id
          JOIN gtfs_static.trip_pattern_map AS trip_map ON trip_map.feed_version_id = version.id
          WHERE version.status = 'active'
          LIMIT 1
        `);
        const current = stable.rows[0];
        assert.ok(current !== undefined);

        const otherNetwork = await migratedAdmin.query<{ id: string }>(`
          INSERT INTO core.network (slug, name_es, name_en, timezone)
          VALUES ('integrity-probe', 'Integrity probe', 'Integrity probe', 'Europe/Madrid')
          RETURNING id
        `);
        const otherNetworkId = otherNetwork.rows[0]!.id;
        const otherStation = await migratedAdmin.query<{ id: string }>(`
          INSERT INTO core.station (network_id, public_id, slug_es, slug_en, name_es, name_en)
          VALUES ($1, 'probe-station', 'probe-station', 'probe-station', 'Probe', 'Probe')
          RETURNING id
        `, [otherNetworkId]);
        const otherLine = await migratedAdmin.query<{ id: string }>(`
          INSERT INTO core.line (network_id, slug, public_code, name_es, name_en)
          VALUES ($1, 'probe-line', 'P', 'Probe', 'Probe')
          RETURNING id
        `, [otherNetworkId]);
        const otherBranch = await migratedAdmin.query<{ id: string }>(`
          INSERT INTO core.branch (line_id, slug, name_es, name_en)
          VALUES ($1, 'probe-branch', 'Probe', 'Probe')
          RETURNING id
        `, [otherLine.rows[0]!.id]);
        const candidate = await migratedAdmin.query<{ id: string }>(`
          INSERT INTO gtfs_static.feed_version (network_id, source_url, sha256, archive_bytes)
          VALUES ($1, 'file:integrity-probe.zip', repeat('b', 64), 1)
          RETURNING id
        `, [current.network_id]);
        const candidateId = candidate.rows[0]!.id;
        await migratedAdmin.query(
          "INSERT INTO gtfs_static.stop (feed_version_id, stop_id, stop_name) VALUES ($1, 'probe-stop', 'Probe')",
          [candidateId],
        );
        await migratedAdmin.query(
          "INSERT INTO gtfs_static.route (feed_version_id, route_id, route_short_name, route_type) VALUES ($1, 'probe-route', 'P', 2)",
          [candidateId],
        );
        await migratedAdmin.query(
          "INSERT INTO gtfs_static.calendar_service (feed_version_id, service_id, monday) VALUES ($1, 'probe-service', true)",
          [candidateId],
        );
        await migratedAdmin.query(
          "INSERT INTO gtfs_static.trip (feed_version_id, trip_id, route_id, service_id) VALUES ($1, 'probe-trip', 'probe-route', 'probe-service')",
          [candidateId],
        );
        await migratedAdmin.query(
          "INSERT INTO gtfs_static.stop_station_map VALUES ($1, 'probe-stop', $2, 'integrity-probe')",
          [candidateId, current.station_id],
        );
        await migratedAdmin.query(
          "INSERT INTO gtfs_static.route_line_map VALUES ($1, 'probe-route', $2, 'integrity-probe')",
          [candidateId, current.line_id],
        );
        await migratedAdmin.query(
          "INSERT INTO gtfs_static.trip_pattern_map VALUES ($1, 'probe-trip', $2, $3, 'integrity-probe')",
          [candidateId, current.branch_id, current.service_pattern_id],
        );
        await migratedAdmin.query(
          'UPDATE gtfs_static.feed_version SET previous_feed_version_id = $2 WHERE id = $1',
          [candidateId, current.active_version_id],
        );

        const rejectedAtSavepoint = async (name: string, query: string, values: unknown[], pattern: RegExp) => {
          await migratedAdmin.query(`SAVEPOINT ${name}`);
          await assert.rejects(migratedAdmin.query(query, values), pattern);
          await migratedAdmin.query(`ROLLBACK TO SAVEPOINT ${name}`);
        };
        await rejectedAtSavepoint(
          'cross_stop',
          "UPDATE gtfs_static.stop_station_map SET station_id = $2 WHERE feed_version_id = $1 AND stop_id = 'probe-stop'",
          [candidateId, otherStation.rows[0]!.id],
          /within the feed network/u,
        );
        await rejectedAtSavepoint(
          'cross_route',
          "UPDATE gtfs_static.route_line_map SET line_id = $2 WHERE feed_version_id = $1 AND route_id = 'probe-route'",
          [candidateId, otherLine.rows[0]!.id],
          /within the feed network/u,
        );
        await rejectedAtSavepoint(
          'branch_mismatch',
          "UPDATE gtfs_static.trip_pattern_map SET branch_id = $2 WHERE feed_version_id = $1 AND trip_id = 'probe-trip'",
          [candidateId, otherBranch.rows[0]!.id],
          /branch and service pattern must agree/u,
        );

        const otherVersion = await migratedAdmin.query<{ id: string }>(`
          INSERT INTO gtfs_static.feed_version (network_id, source_url, sha256, archive_bytes)
          VALUES ($1, 'file:other-network.zip', repeat('c', 64), 1)
          RETURNING id
        `, [otherNetworkId]);
        await rejectedAtSavepoint(
          'cross_previous',
          'UPDATE gtfs_static.feed_version SET previous_feed_version_id = $2 WHERE id = $1',
          [otherVersion.rows[0]!.id, current.active_version_id],
          /same network/u,
        );
        const unsuccessful = await migratedAdmin.query<{ id: string }>(`
          INSERT INTO gtfs_static.feed_version (network_id, source_url, sha256, archive_bytes)
          VALUES ($1, 'file:unsuccessful.zip', repeat('d', 64), 1)
          RETURNING id
        `, [current.network_id]);
        await rejectedAtSavepoint(
          'unsuccessful_previous',
          'UPDATE gtfs_static.feed_version SET previous_feed_version_id = $2 WHERE id = $1',
          [candidateId, unsuccessful.rows[0]!.id],
          /successful active or superseded/u,
        );
      } finally {
        await migratedAdmin.query('ROLLBACK').catch(() => undefined);
        await migratedAdmin.end();
      }
    });

    await t.test('doctor rejects dormant settable privilege and indirect group escalation paths', async () => {
      const privilegedRole = `atodotren_test_privileged_${process.pid}`;
      const indirectRole = `atodotren_test_indirect_${process.pid}`;
      await admin.query(`CREATE ROLE ${privilegedRole} NOLOGIN CREATEDB`);
      await admin.query(`CREATE ROLE ${indirectRole} NOLOGIN`);
      try {
        await admin.query(
          `GRANT ${privilegedRole} TO atodotren_worker WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
        );
        const dormant = await runWorkerDoctor();
        assert.equal(dormant.code, 1);
        assert.match(dormant.stdout, /exact required membership/u);
        await admin.query(`REVOKE ${privilegedRole} FROM atodotren_worker`);

        await admin.query(
          `GRANT ${indirectRole} TO atodotren_ingest_writer WITH ADMIN FALSE, INHERIT TRUE, SET FALSE`,
        );
        const indirect = await runWorkerDoctor();
        assert.equal(indirect.code, 1);
        assert.match(indirect.stdout, /must not reach any parent roles/u);
      } finally {
        await admin.query(`REVOKE ${privilegedRole} FROM atodotren_worker`);
        await admin.query(`REVOKE ${indirectRole} FROM atodotren_ingest_writer`);
        await admin.query(`DROP ROLE IF EXISTS ${privilegedRole}`);
        await admin.query(`DROP ROLE IF EXISTS ${indirectRole}`);
      }
    });

    await t.test('doctor requires repository and database migration state to be exactly synchronized', async () => {
      const migratedAdmin = new Client({ connectionString: adminDatabaseUrl });
      await migratedAdmin.connect();
      const directory = await mkdtemp(join(tmpdir(), 'atodotren-doctor-state-'));
      try {
        const foundation = join(directory, '0001_repository_foundation.sql');
        const staticFoundation = join(directory, '0002_static_madrid_foundation.sql');
        await copyCurrentMigrations(directory);
        assert.equal((await runWorkerDoctor(directory)).code, 0);

        await writeFile(join(directory, '9002_pending_probe.sql'), 'SELECT 1;\n');
        assert.equal((await runWorkerDoctor(directory)).code, 1);
        await rm(join(directory, '9002_pending_probe.sql'));

        await migratedAdmin.query(
          "INSERT INTO operations.schema_migration (name, checksum) VALUES ('9999_fabricated.sql', repeat('f', 64))",
        );
        assert.equal((await runWorkerDoctor(directory)).code, 1);
        await migratedAdmin.query("DELETE FROM operations.schema_migration WHERE name = '9999_fabricated.sql'");

        await migratedAdmin.query(
          "UPDATE operations.schema_migration SET checksum = repeat('0', 64) WHERE name = '0001_repository_foundation.sql'",
        );
        assert.equal((await runWorkerDoctor(directory)).code, 1);
        await migratedAdmin.query(
          "UPDATE operations.schema_migration SET checksum = '13ff887ab7942ba53322d85e33e7ea28280dc29006257ddfb36a3e352274132c' WHERE name = '0001_repository_foundation.sql'",
        );

        await rm(foundation);
        await writeFile(join(directory, '9003_only.sql'), 'SELECT 1;\n');
        assert.equal((await runWorkerDoctor(directory)).code, 1);
        await rm(join(directory, '9003_only.sql'));
        await cp(resolve(process.cwd(), 'migrations/0001_repository_foundation.sql'), foundation);
        await rm(staticFoundation);
        await writeFile(join(directory, 'BAD.sql'), 'SELECT 1;\n');
        assert.equal((await runWorkerDoctor(directory)).code, 1);
        assert.equal((await runWorkerDoctor(join(directory, 'unreadable'))).code, 1);
      } finally {
        await migratedAdmin.query("DELETE FROM operations.schema_migration WHERE name = '9999_fabricated.sql'");
        await migratedAdmin.query(
          "UPDATE operations.schema_migration SET checksum = '13ff887ab7942ba53322d85e33e7ea28280dc29006257ddfb36a3e352274132c' WHERE name = '0001_repository_foundation.sql'",
        );
        await migratedAdmin.end();
        await rm(directory, { recursive: true, force: true });
      }
    });

    await t.test('worker doctor succeeds against the least-privilege connection', async () => {
      const result = await runWorkerDoctor();
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /"event":"doctor\.complete"/);
      assert.match(result.stdout, /"ok":true/);
      assert.match(result.stdout, /"status":"deferred"/);
    });
  } finally {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    if (rotatedLogin !== undefined) {
      await admin.query(`DROP ROLE IF EXISTS ${rotatedLogin}`);
    }
    await admin.end();
  }
});
