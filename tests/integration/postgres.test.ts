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

async function runWorkerDoctor(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['apps/worker/dist/cli.js', 'doctor'], {
    cwd: process.cwd(),
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DATABASE_URL: workerDatabaseUrl,
      DATABASE_SSL_MODE: 'disable',
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
          /membership with ADMIN FALSE, INHERIT FALSE, SET TRUE/,
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
