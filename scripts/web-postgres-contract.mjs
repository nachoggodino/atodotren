import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
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

const databaseName = `atodotren_web_contract_${process.pid}_${Date.now()}`;
const adminBase = required("TEST_ADMIN_DATABASE_URL");
const migratorBase = required("TEST_MIGRATOR_DATABASE_URL");
const webBase = required("TEST_WEB_DATABASE_URL");
const adminDb = withDatabase(adminBase, databaseName);
const migratorDb = withDatabase(migratorBase, databaseName);
const webDb = withDatabase(webBase, databaseName);
const admin = new Client({ connectionString: adminBase });

await admin.connect();
try {
  const membership = await admin.query(`
    SELECT granted.rolname AS granted_role, membership.admin_option,
      membership.inherit_option, membership.set_option
    FROM pg_auth_members AS membership
    JOIN pg_roles AS member ON member.oid = membership.member
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    WHERE member.rolname = 'atodotren_web'
    ORDER BY granted.rolname
  `);
  assert.deepEqual(membership.rows, [{ granted_role: "atodotren_web_reader", admin_option: false, inherit_option: true, set_option: false }]);

  await admin.query(`CREATE DATABASE ${databaseName}`);
  const bootstrap = new Client({ connectionString: adminDb });
  await bootstrap.connect();
  try {
    await bootstrap.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
    await bootstrap.query(`GRANT CREATE ON DATABASE ${databaseName} TO atodotren_migration_admin`);
  } finally {
    await bootstrap.end();
  }

  const migration = await migrateToLatest({
    connection: {
      url: migratorDb,
      sslMode: "disable",
      poolMax: 2,
      connectionTimeoutMs: 5_000,
      idleTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
      applicationName: "atodotren-web-contract-migrate",
    },
    migrationsDirectory: new URL("../migrations", import.meta.url).pathname,
  });
  assert.equal(migration.applied.at(-1), "0016_web_search_normalization.sql");

  const databaseAdmin = new Client({ connectionString: adminDb });
  await databaseAdmin.connect();
  try {
    const network = await databaseAdmin.query("SELECT id FROM core.network WHERE slug='madrid'");
    assert.equal(network.rowCount, 1);
    const networkId = network.rows[0].id;
    await databaseAdmin.query(`INSERT INTO core.line (network_id, slug, public_code, name_es, name_en, color, text_color, display_order) VALUES ($1, 'c1', 'C1', 'C1', 'C1', '5AA1D8', 'FFFFFF', 1)`, [networkId]);
    await databaseAdmin.query(`INSERT INTO core.station (network_id, public_id, slug_es, slug_en, name_es, name_en) VALUES ($1, 'atocha', 'atocha', 'atocha', 'Atocha', 'Atocha')`, [networkId]);
  } finally {
    await databaseAdmin.end();
  }

  const web = new Client({ connectionString: webDb, statement_timeout: 5_000, application_name: "atodotren-web-contract-reader" });
  await web.connect();
  try {
    const privileges = await web.query(`SELECT
      has_schema_privilege(current_user, 'api', 'USAGE') AS api_usage,
      has_schema_privilege(current_user, 'core', 'USAGE') AS core_usage,
      has_table_privilege(current_user, 'api.line_catalog', 'SELECT') AS api_line_select,
      has_table_privilege(current_user, 'core.line', 'SELECT') AS private_line_select,
      has_table_privilege(current_user, 'ingest.live_vehicle_state', 'SELECT') AS ingest_select,
      has_table_privilege(current_user, 'analytics.daily_line_summary', 'SELECT') AS analytics_select,
      has_table_privilege(current_user, 'operations.ingest_health', 'SELECT') AS operations_select`);
    assert.deepEqual(privileges.rows[0], { api_usage: true, core_usage: false, api_line_select: true, private_line_select: false, ingest_select: false, analytics_select: false, operations_select: false });

    const search = await web.query("SELECT * FROM api.catalog_search($1, $2)", ["C-1", 999]);
    assert.equal(search.rowCount, 1);
    assert.equal(search.rows[0].entity_kind, "line");
    assert.equal(search.rows[0].public_code, "C1");
    assert.ok(search.rowCount <= 20);

    const station = await web.query("SELECT * FROM api.catalog_search($1, 12)", ["Atocha"]);
    assert.equal(station.rows.some((row) => row.entity_kind === "station" && row.stable_id === "atocha"), true);

    const outOfRange = new Date();
    outOfRange.setUTCDate(outOfRange.getUTCDate() - 31);
    await assert.rejects(web.query("SELECT * FROM api.recent_line_matrix('c1', $1::date, 6000)", [outOfRange.toISOString().slice(0, 10)]), /outside the 30-day detailed-data window/);

    await assert.rejects(web.query("SELECT * FROM core.line"), /permission denied/);

    const started = performance.now();
    for (let index = 0; index < 25; index += 1) await web.query("SELECT * FROM api.catalog_search('C1', 12)");
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2_500, `25 representative catalog queries took ${elapsed.toFixed(1)}ms`);
    console.log(JSON.stringify({ web_public_api_contract: true, representative_queries: 25, elapsed_ms: Number(elapsed.toFixed(1)), average_ms: Number((elapsed / 25).toFixed(2)) }));
  } finally {
    await web.end();
  }
} finally {
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [databaseName]);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
  } finally {
    await admin.end();
  }
}
