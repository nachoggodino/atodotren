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
  assert.equal(migration.applied.at(-1), "0019_web_history_insights.sql");

  const databaseAdmin = new Client({ connectionString: adminDb });
  await databaseAdmin.connect();
  try {
    const network = await databaseAdmin.query("SELECT id FROM core.network WHERE slug='madrid'");
    assert.equal(network.rowCount, 1);
    const networkId = network.rows[0].id;
    await databaseAdmin.query(`INSERT INTO core.line (network_id, slug, public_code, name_es, name_en, color, text_color, display_order) VALUES ($1, 'c1', 'C1', 'C1', 'C1', '5AA1D8', 'FFFFFF', 1)`, [networkId]);
    await databaseAdmin.query(`INSERT INTO core.station (network_id, public_id, slug_es, slug_en, name_es, name_en) VALUES ($1, 'atocha', 'atocha', 'atocha', 'Atocha', 'Atocha')`, [networkId]);

    const freshness = await databaseAdmin.query(`SELECT
      api.live_vehicle_is_active(
        '2026-08-25'::date,
        '2026-08-25T11:59:00Z'::timestamptz,
        extract(epoch FROM '2026-08-25T11:59:00Z'::timestamptz)::bigint,
        'Europe/Madrid',
        '2026-08-25T12:00:00Z'::timestamptz
      ) AS fresh,
      api.live_vehicle_is_active(
        '2026-08-25'::date,
        '2026-08-25T11:57:59Z'::timestamptz,
        extract(epoch FROM '2026-08-25T11:59:00Z'::timestamptz)::bigint,
        'Europe/Madrid',
        '2026-08-25T12:00:00Z'::timestamptz
      ) AS stale_capture,
      api.live_vehicle_is_active(
        '2026-08-25'::date,
        '2026-08-25T11:59:00Z'::timestamptz,
        extract(epoch FROM '2026-08-25T11:57:59Z'::timestamptz)::bigint,
        'Europe/Madrid',
        '2026-08-25T12:00:00Z'::timestamptz
      ) AS stale_vehicle,
      api.live_vehicle_is_active(
        '2026-08-24'::date,
        '2026-08-25T11:59:00Z'::timestamptz,
        NULL::bigint,
        'Europe/Madrid',
        '2026-08-25T12:00:00Z'::timestamptz
      ) AS wrong_service_date,
      api.live_vehicle_is_active(
        '2026-08-25'::date,
        '2026-08-25T12:00:31Z'::timestamptz,
        NULL::bigint,
        'Europe/Madrid',
        '2026-08-25T12:00:00Z'::timestamptz
      ) AS future_capture`);
    assert.deepEqual(freshness.rows[0], {
      fresh: true,
      stale_capture: false,
      stale_vehicle: false,
      wrong_service_date: false,
      future_capture: false,
    });
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
      has_table_privilege(current_user, 'api.active_live_vehicle', 'SELECT') AS active_live_select,
      has_table_privilege(current_user, 'api.history_segment_hour', 'SELECT') AS history_segment_select,
      has_function_privilege(current_user, 'api.landing_delay_timeline(text,timestamptz)', 'EXECUTE') AS landing_timeline_execute,
      has_function_privilege(current_user, 'api.live_vehicle_is_active(date,timestamptz,bigint,text,timestamptz)', 'EXECUTE') AS live_predicate_execute`);
    assert.deepEqual(privileges.rows[0], {
      api_usage: true,
      core_usage: false,
      api_line_select: true,
      active_live_select: true,
      history_segment_select: true,
      landing_timeline_execute: true,
      live_predicate_execute: false,
    });

    await assert.rejects(web.query("SELECT * FROM core.line"), /permission denied/);
    await assert.rejects(web.query("SELECT * FROM ingest.live_vehicle_state"), /permission denied/);
    await assert.rejects(web.query("SELECT * FROM analytics.daily_line_summary"), /permission denied/);
    await assert.rejects(web.query("SELECT * FROM operations.ingest_health"), /permission denied/);

    const search = await web.query("SELECT * FROM api.catalog_search($1, $2)", ["C-1", 999]);
    assert.equal(search.rowCount, 1);
    assert.equal(search.rows[0].entity_kind, "line");
    assert.equal(search.rows[0].public_code, "C1");
    assert.ok(search.rowCount <= 20);

    const station = await web.query("SELECT * FROM api.catalog_search($1, 12)", ["Atocha"]);
    assert.equal(station.rows.some((row) => row.entity_kind === "station" && row.stable_id === "atocha"), true);

    const activeVehicles = await web.query("SELECT * FROM api.active_live_vehicle");
    assert.equal(activeVehicles.rowCount, 0);

    const segments = await web.query("SELECT * FROM api.history_segment_hour WHERE network_slug = 'madrid' LIMIT 1");
    assert.equal(segments.rowCount, 0);

    const landingTimeline = await web.query("SELECT * FROM api.landing_delay_timeline('madrid', '2026-08-25T12:00:00Z'::timestamptz)");
    assert.equal(landingTimeline.rowCount, 43);
    assert.equal(landingTimeline.rows[0].accumulated_journey_delay_seconds, "0");
    assert.equal(landingTimeline.rows.every((row) => row.current_accumulated_journey_delay_seconds === "0"), true);
    assert.equal(landingTimeline.rows.at(-1).accumulated_journey_delay_seconds, null);

    const outOfRange = new Date();
    outOfRange.setUTCDate(outOfRange.getUTCDate() - 31);
    await assert.rejects(web.query("SELECT * FROM api.recent_line_matrix('c1', $1::date, 6000)", [outOfRange.toISOString().slice(0, 10)]), /outside the 30-day detailed-data window/);

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