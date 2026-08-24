import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { migrateToLatest } from '@atodotren/db';
import { Client } from 'pg';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required; integration tests never skip unavailable PostgreSQL`);
  return value;
}

function withDatabase(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const databaseName = `atodotren_m5_${process.pid}_${Date.now()}`;
const adminBaseUrl = requiredEnvironment('TEST_ADMIN_DATABASE_URL');
const migratorBaseUrl = requiredEnvironment('TEST_MIGRATOR_DATABASE_URL');
const telegramBaseUrl = requiredEnvironment('TEST_TELEGRAM_DATABASE_URL');
const adminDatabaseUrl = withDatabase(adminBaseUrl, databaseName);
const migratorDatabaseUrl = withDatabase(migratorBaseUrl, databaseName);
const telegramDatabaseUrl = withDatabase(telegramBaseUrl, databaseName);

const connectionOptions = {
  sslMode: 'disable' as const,
  poolMax: 2,
  connectionTimeoutMs: 5_000,
  idleTimeoutMs: 5_000,
  statementTimeoutMs: 5_000,
};

async function copyMilestone4Migrations(directory: string): Promise<void> {
  await Promise.all([
    '0001_repository_foundation.sql',
    '0002_static_madrid_foundation.sql',
    '0003_static_mapping_integrity.sql',
    '0004_realtime_ingestion.sql',
    '0005_canonical_journeys.sql',
    '0006_aggregation_retention.sql',
    '0007_m4_correctness_gates.sql',
    '0008_timetable_metric_identity.sql',
  ].map(async (name) => cp(resolve(process.cwd(), 'migrations', name), join(directory, name))));
}

function runRoleBootstrap(database: string, telegramPassword: string): void {
  const container = requiredEnvironment('POSTGRES_CONTRACT_CONTAINER_NAME');
  const result = spawnSync('docker', [
    'exec',
    '--env', `POSTGRES_DB=${database}`,
    '--env', 'POSTGRES_USER=postgres',
    '--env', `POSTGRES_PASSWORD=${requiredEnvironment('POSTGRES_CONTRACT_ADMIN_PASSWORD')}`,
    '--env', `ATODOTREN_WORKER_PASSWORD=${requiredEnvironment('POSTGRES_CONTRACT_WORKER_PASSWORD')}`,
    '--env', `ATODOTREN_TELEGRAM_PASSWORD=${telegramPassword}`,
    container,
    '/docker-entrypoint-initdb.d/001-runtime-roles.sh',
  ], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.status, 0, 'shared role bootstrap must succeed against the retained cluster');
}

void test('existing Milestone 4 database upgrades roles before 0009 without replacing data or passwords', async () => {
  const upgradeName = `${databaseName}_upgrade`;
  const upgradeAdminUrl = withDatabase(adminBaseUrl, upgradeName);
  const upgradeMigratorUrl = withDatabase(migratorBaseUrl, upgradeName);
  const upgradeTelegramUrl = withDatabase(telegramBaseUrl, upgradeName);
  const originalTelegramPassword = requiredEnvironment('POSTGRES_CONTRACT_TELEGRAM_PASSWORD');
  const milestone4Migrations = await mkdtemp(join(tmpdir(), 'atodotren-m5-m4-'));
  await copyMilestone4Migrations(milestone4Migrations);
  const admin = new Client({ connectionString: adminBaseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${upgradeName}`);
    const bootstrap = new Client({ connectionString: upgradeAdminUrl });
    await bootstrap.connect();
    try {
      await bootstrap.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await bootstrap.query(`GRANT CREATE ON DATABASE ${upgradeName} TO atodotren_migration_admin`);
    } finally {
      await bootstrap.end();
    }

    await migrateToLatest({
      connection: { ...connectionOptions, url: upgradeMigratorUrl, applicationName: 'atodotren-m4-retained-volume' },
      migrationsDirectory: milestone4Migrations,
    });

    const beforeUpgrade = new Client({ connectionString: upgradeAdminUrl });
    await beforeUpgrade.connect();
    try {
      const ledger = await beforeUpgrade.query<{ name: string }>('SELECT name FROM operations.schema_migration ORDER BY name');
      assert.equal(ledger.rows.at(-1)?.name, '0008_timetable_metric_identity.sql');
      await beforeUpgrade.query('CREATE TABLE operations.m5_upgrade_sentinel (id integer PRIMARY KEY, value integer NOT NULL)');
      await beforeUpgrade.query('INSERT INTO operations.m5_upgrade_sentinel (id, value) VALUES (1, 42)');
    } finally {
      await beforeUpgrade.end();
    }

    await admin.query('DROP ROLE atodotren_telegram');
    await admin.query('DROP ROLE atodotren_reporting_reader');
    try {
      await assert.rejects(migrateToLatest({
        connection: { ...connectionOptions, url: upgradeMigratorUrl, applicationName: 'atodotren-m5-pre-bootstrap' },
        migrationsDirectory: resolve(process.cwd(), 'migrations'),
      }), /atodotren_reporting_reader is missing/u);

      const blockedLedger = new Client({ connectionString: upgradeAdminUrl });
      await blockedLedger.connect();
      try {
        const ledger = await blockedLedger.query<{ name: string }>('SELECT name FROM operations.schema_migration ORDER BY name');
        assert.equal(ledger.rows.at(-1)?.name, '0008_timetable_metric_identity.sql');
      } finally {
        await blockedLedger.end();
      }
    } finally {
      runRoleBootstrap(upgradeName, originalTelegramPassword);
    }

    runRoleBootstrap(upgradeName, 'ci-password-that-must-not-rotate-an-existing-login');

    await migrateToLatest({
      connection: { ...connectionOptions, url: upgradeMigratorUrl, applicationName: 'atodotren-m5-post-bootstrap' },
      migrationsDirectory: resolve(process.cwd(), 'migrations'),
    });

    const upgradedAdmin = new Client({ connectionString: upgradeAdminUrl });
    await upgradedAdmin.connect();
    try {
      const sentinel = await upgradedAdmin.query<{ value: number }>('SELECT value FROM operations.m5_upgrade_sentinel WHERE id = 1');
      assert.equal(sentinel.rows[0]?.value, 42);
      const ledger = await upgradedAdmin.query<{ name: string }>('SELECT name FROM operations.schema_migration ORDER BY name');
      assert.equal(ledger.rows.at(-1)?.name, '0011_isolated_maintenance_finalization.sql');
      const memberships = await upgradedAdmin.query<{
        role: string;
        admin_option: boolean;
        inherit_option: boolean;
        set_option: boolean;
      }>(`SELECT granted.rolname AS role, membership.admin_option, membership.inherit_option, membership.set_option
        FROM pg_auth_members AS membership
        JOIN pg_roles AS member ON member.oid = membership.member
        JOIN pg_roles AS granted ON granted.oid = membership.roleid
        WHERE member.rolname = 'atodotren_telegram'`);
      assert.deepEqual(memberships.rows, [{
        role: 'atodotren_reporting_reader', admin_option: false, inherit_option: true, set_option: false,
      }]);
    } finally {
      await upgradedAdmin.end();
    }

    const telegram = new Client({ connectionString: upgradeTelegramUrl });
    await telegram.connect();
    try {
      await telegram.query('SELECT * FROM operations.report_database_size LIMIT 1');
    } finally {
      await telegram.end();
    }
  } finally {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [upgradeName]);
    await admin.query(`DROP DATABASE IF EXISTS ${upgradeName}`);
    await admin.end();
    await rm(milestone4Migrations, { recursive: true, force: true });
  }
});

void test('Milestone 5 reporting role and Telegram state stay least-privilege', async (t) => {
  const admin = new Client({ connectionString: adminBaseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const bootstrap = new Client({ connectionString: adminDatabaseUrl });
    await bootstrap.connect();
    try {
      await bootstrap.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await bootstrap.query(`GRANT CREATE ON DATABASE ${databaseName} TO atodotren_migration_admin`);
    } finally {
      await bootstrap.end();
    }

    await migrateToLatest({
      connection: { ...connectionOptions, url: migratorDatabaseUrl, applicationName: 'atodotren-m5-permissions' },
      migrationsDirectory: resolve(process.cwd(), 'migrations'),
    });

    const telegram = new Client({ connectionString: telegramDatabaseUrl });
    const telegram2 = new Client({ connectionString: telegramDatabaseUrl });
    await telegram.connect();
    await telegram2.connect();
    await t.test('approved report reads and private Telegram state writes succeed', async () => {
      await telegram.query('SELECT * FROM operations.report_daily_summary LIMIT 1');
      await telegram.query('SELECT * FROM operations.report_ingest_health LIMIT 1');
      await telegram.query('SELECT * FROM operations.report_database_size LIMIT 1');
      await telegram.query(`INSERT INTO operations.telegram_delivery (
        delivery_key, delivery_type, report_version, attempt_count, expires_at
      ) VALUES ('ci-command', 'command', 'pilot-v1', 1, clock_timestamp() + interval '1 day')`);
      await telegram.query("UPDATE operations.telegram_delivery SET failure_class = 'FakeFailure' WHERE delivery_key = 'ci-command'");
      const result = await telegram.query<{ failure_class: string | null }>("SELECT failure_class FROM operations.telegram_delivery WHERE delivery_key = 'ci-command'");
      assert.equal(result.rows[0]?.failure_class, 'FakeFailure');
      await telegram.query(`INSERT INTO operations.telegram_resource_sample (
        sampled_at, database_bytes, spool_bytes, cpu_ratio, memory_ratio, disk_free_ratio
      ) VALUES (clock_timestamp(), 1000, 200, 0.1, 0.2, 0.8)`);
      const samples = await telegram.query<{ database_bytes: string }>('SELECT database_bytes FROM operations.telegram_resource_sample');
      assert.equal(Number(samples.rows[0]?.database_bytes), 1000);
      await telegram.query('SELECT operations.telegram_prune_state(clock_timestamp())');
    });

    await t.test('single-consumer advisory lock excludes a second bot instance', async () => {
      const first = await telegram.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('atodotren:telegram-long-poll', 0)) AS locked");
      const second = await telegram2.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('atodotren:telegram-long-poll', 0)) AS locked");
      assert.equal(first.rows[0]?.locked, true);
      assert.equal(second.rows[0]?.locked, false);
      await telegram.query("SELECT pg_advisory_unlock(hashtextextended('atodotren:telegram-long-poll', 0))");
    });

    await t.test('all ingestion, canonical, aggregate, migration and alias writes are denied', async () => {
      const prohibited = [
        "INSERT INTO operations.notification_incident (incident_key,opened_at,last_observed_at,details) VALUES ('forbidden',clock_timestamp(),clock_timestamp(),'{}')",
        'UPDATE operations.ingest_health SET consecutive_failures = 99 WHERE singleton',
        "INSERT INTO operations.reporting_alias (entity_kind,entity_id,alias) VALUES ('line',1,'forbidden')",
        "DELETE FROM operations.telegram_delivery WHERE delivery_key = 'ci-command'",
        'DELETE FROM operations.telegram_resource_sample',
        'SET ROLE atodotren_ingest_writer',
        'SET ROLE atodotren_migration_admin',
      ];
      for (const sql of prohibited) await assert.rejects(telegram.query(sql), /permission denied|SET ROLE|set role/u);
      await assert.rejects(telegram.query('SELECT * FROM ingest.poll_run LIMIT 1'), /permission denied/u);
      await assert.rejects(telegram.query('SELECT * FROM core.journey LIMIT 1'), /permission denied/u);
      await assert.rejects(telegram.query('SELECT * FROM analytics.daily_stop_call_hour LIMIT 1'), /permission denied/u);
      await assert.rejects(telegram.query('SELECT * FROM operations.schema_migration LIMIT 1'), /permission denied/u);
    });

    await t.test('service-date recovery migration is applied after reporting readiness', async () => {
      const databaseAdmin = new Client({ connectionString: adminDatabaseUrl });
      await databaseAdmin.connect();
      try {
        const ledger = await databaseAdmin.query<{ name: string }>('SELECT name FROM operations.schema_migration ORDER BY name');
        assert.equal(ledger.rows.at(-1)?.name, '0011_isolated_maintenance_finalization.sql');
      } finally {
        await databaseAdmin.end();
      }
    });

    await telegram.end();
    await telegram2.end();
  } finally {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});
