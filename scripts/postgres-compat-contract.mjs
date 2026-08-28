import assert from "node:assert/strict";
import { URL } from "node:url";
import { Client } from "pg";
import { migrateToLatest } from "../packages/db/dist/index.js";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function withDatabase(connectionUrl, name) {
  const url = new URL(connectionUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const databaseName = `atodotren_pg_compat_${process.pid}_${Date.now()}`;
const adminBase = required("TEST_ADMIN_DATABASE_URL");
const migratorBase = required("TEST_MIGRATOR_DATABASE_URL");
const workerBase = required("TEST_WORKER_DATABASE_URL");
const webBase = required("TEST_WEB_DATABASE_URL");
const adminDb = withDatabase(adminBase, databaseName);
const migratorDb = withDatabase(migratorBase, databaseName);
const workerDb = withDatabase(workerBase, databaseName);
const webDb = withDatabase(webBase, databaseName);
const admin = new Client({ connectionString: adminBase });

await admin.connect();
try {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const bootstrap = new Client({ connectionString: adminDb });
  await bootstrap.connect();
  try {
    await bootstrap.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
    await bootstrap.query(`GRANT CREATE ON DATABASE ${databaseName} TO atodotren_migration_admin`);
  } finally {
    await bootstrap.end();
  }

  const migrated = await migrateToLatest({
    connection: {
      url: migratorDb,
      sslMode: "disable",
      poolMax: 2,
      connectionTimeoutMs: 5_000,
      idleTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
      applicationName: "atodotren-postgres-compat-migrate",
    },
    migrationsDirectory: new URL("../migrations", import.meta.url).pathname,
  });
  assert.equal(migrated.applied.at(-1), "0021_web_station_metrics.sql");

  const databaseAdmin = new Client({ connectionString: adminDb });
  await databaseAdmin.connect();
  try {
    const version = await databaseAdmin.query("SHOW server_version_num");
    const serverVersion = Number(version.rows[0]?.server_version_num);
    assert.ok(serverVersion >= 160_000 && serverVersion < 170_000, `expected PostgreSQL 16, received server_version_num=${serverVersion}`);
    const serviceTimes = await databaseAdmin.query(`SELECT
      core.service_instant('2026-03-29', 9000, 'Europe/Madrid') AS spring,
      core.service_instant('2026-10-25', 9000, 'Europe/Madrid') AS fall`);
    assert.equal(serviceTimes.rows[0]?.spring.toISOString(), "2026-03-29T01:30:00.000Z");
    assert.equal(serviceTimes.rows[0]?.fall.toISOString(), "2026-10-25T01:30:00.000Z");
  } finally {
    await databaseAdmin.end();
  }

  const worker = new Client({ connectionString: workerDb, statement_timeout: 5_000 });
  await worker.connect();
  try {
    const health = await worker.query("SELECT checked_at FROM operations.database_health");
    assert.equal(health.rowCount, 1);
    await assert.rejects(worker.query("SELECT * FROM api.line_catalog LIMIT 1"), /permission denied/);
  } finally {
    await worker.end();
  }

  const web = new Client({ connectionString: webDb, statement_timeout: 5_000 });
  await web.connect();
  try {
    const privileges = await web.query(`SELECT
      has_schema_privilege(current_user, 'api', 'USAGE') AS api_usage,
      has_schema_privilege(current_user, 'core', 'USAGE') AS core_usage,
      has_table_privilege(current_user, 'api.line_catalog', 'SELECT') AS line_select,
      has_table_privilege(current_user, 'api.active_live_vehicle', 'SELECT') AS live_select,
      has_table_privilege(current_user, 'api.upcoming_station_live_vehicle', 'SELECT') AS station_arrival_select,
      has_table_privilege(current_user, 'api.history_segment_hour', 'SELECT') AS history_select,
      has_function_privilege(current_user, 'api.station_live_day_metrics(text,date,timestamptz)', 'EXECUTE') AS station_metrics_execute`);
    assert.deepEqual(privileges.rows[0], {
      api_usage: true,
      core_usage: false,
      line_select: true,
      live_select: true,
      station_arrival_select: true,
      history_select: true,
      station_metrics_execute: true,
    });
    await web.query("SELECT * FROM api.line_catalog LIMIT 1");
    await web.query("SELECT * FROM api.active_live_vehicle LIMIT 1");
    await web.query("SELECT * FROM api.upcoming_station_live_vehicle LIMIT 1");
    await web.query("SELECT * FROM api.history_segment_hour LIMIT 1");
    await web.query("SELECT * FROM api.station_live_day_metrics('atocha', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Madrid')::date, CURRENT_TIMESTAMP)");
    await assert.rejects(web.query("SELECT * FROM core.line LIMIT 1"), /permission denied/);
  } finally {
    await web.end();
  }

  console.log(JSON.stringify({ postgres_compat_contract: true, migrations_latest: "0021_web_station_metrics.sql" }));
} finally {
  try {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
  } finally {
    await admin.end();
  }
}
