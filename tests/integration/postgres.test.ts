import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { migrateToLatest } from '@atodotren/db';
import { Client } from 'pg';

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
      assert.deepEqual(result.applied, ['0001_repository_foundation.sql']);
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
      assert.deepEqual(result.alreadyApplied, ['0001_repository_foundation.sql']);
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
        await cp(resolve(process.cwd(), 'migrations/0001_repository_foundation.sql'), join(temporaryMigrations, '0001_repository_foundation.sql'));
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
        await cp(resolve(process.cwd(), 'migrations/0001_repository_foundation.sql'), join(temporaryMigrations, '0001_repository_foundation.sql'));
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
        await cp(
          resolve(process.cwd(), 'migrations/0001_repository_foundation.sql'),
          join(temporaryMigrations, '0001_repository_foundation.sql'),
        );
        await writeFile(
          join(temporaryMigrations, '0002_rotation_probe.sql'),
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
        assert.deepEqual(result.applied, ['0002_rotation_probe.sql']);
        assert.deepEqual(result.alreadyApplied, ['0001_repository_foundation.sql']);

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
            "DELETE FROM operations.schema_migration WHERE name = '0002_rotation_probe.sql'",
          );
        } finally {
          await migratedAdmin.end();
        }
      } finally {
        await rm(temporaryMigrations, { recursive: true, force: true });
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
        await cp(resolve(process.cwd(), 'migrations/0001_repository_foundation.sql'), foundation);
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
