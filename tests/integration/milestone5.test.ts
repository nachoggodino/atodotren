import assert from 'node:assert/strict';
import { resolve } from 'node:path';
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
    t.after(async () => {
      await telegram.end().catch(() => undefined);
      await telegram2.end().catch(() => undefined);
    });

    await t.test('approved report reads and private Telegram state writes succeed', async () => {
      await telegram.query('SELECT * FROM operations.report_daily_summary LIMIT 1');
      await telegram.query('SELECT * FROM operations.report_ingest_health LIMIT 1');
      await telegram.query('SELECT * FROM operations.report_database_size LIMIT 1');
      await telegram.query(`INSERT INTO operations.telegram_delivery (
        delivery_key, delivery_type, report_version, attempt_count, expires_at
      ) VALUES ('ci-command', 'command', 'pilot-v1', 1, clock_timestamp() + interval '1 day')`);
      await telegram.query("UPDATE operations.telegram_delivery SET failure_class = 'FakeFailure' WHERE delivery_key = 'ci-command'");
      const result = await telegram.query("SELECT failure_class FROM operations.telegram_delivery WHERE delivery_key = 'ci-command'");
      assert.equal(result.rows[0]?.failure_class, 'FakeFailure');
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
        'SET ROLE atodotren_ingest_writer',
        'SET ROLE atodotren_migration_admin',
      ];
      for (const sql of prohibited) await assert.rejects(telegram.query(sql), /permission denied|SET ROLE|set role/u);
      await assert.rejects(telegram.query('SELECT * FROM ingest.poll_run LIMIT 1'), /permission denied/u);
      await assert.rejects(telegram.query('SELECT * FROM core.journey LIMIT 1'), /permission denied/u);
      await assert.rejects(telegram.query('SELECT * FROM analytics.daily_stop_call_hour LIMIT 1'), /permission denied/u);
      await assert.rejects(telegram.query('SELECT * FROM operations.schema_migration LIMIT 1'), /permission denied/u);
    });

    await t.test('migration 0009 is applied after immutable migrations 0001-0008', async () => {
      const databaseAdmin = new Client({ connectionString: adminDatabaseUrl });
      await databaseAdmin.connect();
      try {
        const ledger = await databaseAdmin.query('SELECT name FROM operations.schema_migration ORDER BY name');
        assert.equal(ledger.rows.at(-1)?.name, '0009_reporting_telegram.sql');
      } finally {
        await databaseAdmin.end();
      }
    });
  } finally {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});
