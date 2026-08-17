import { sql } from 'kysely';

import type { DatabaseConnection } from './connection.js';
import {
  atodotrenGroupRoles,
  atodotrenRoles,
  runtimeSchemas,
  supportedPostgresMajors,
} from './contract.js';
import { readMigrationInventory, reconcileMigrationState } from './migration-inventory.js';
import { validateRoleContract } from './roles.js';

export interface DoctorCheck {
  readonly name: string;
  readonly status: 'pass' | 'deferred';
  readonly details: Readonly<Record<string, unknown>>;
}

export interface DoctorReport {
  readonly ok: true;
  readonly scope: 'milestone-2';
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorOptions {
  readonly connection: DatabaseConnection;
  readonly migrationsDirectory: string;
  readonly maxClockSkewMs: number;
  readonly now?: () => Date;
  readonly realtime?: {
    readonly endpoints: readonly { readonly kind: string; readonly enabled: boolean; readonly url: string }[];
    readonly pollFreshnessMs: number;
    readonly spool: {
      readonly path: string;
      readonly writable: boolean;
      readonly sizeBytes: number;
      readonly maxBytes: number;
      readonly pendingCount: number;
      readonly droppedCount: number;
    };
    readonly heartbeatConfigured: boolean;
  };
}

interface ConnectionRow {
  current_database: string;
  current_user: string;
  server_version: string;
  server_version_num: string;
  database_time: Date;
  in_recovery: boolean;
}

interface PermissionRow {
  schema_name: string;
  has_usage: boolean;
  has_create: boolean;
}

export async function runDatabaseDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const now = options.now ?? (() => new Date());
  const checks: DoctorCheck[] = [];

  const connectionResult = await sql<ConnectionRow>`
    SELECT
      current_database() AS current_database,
      current_user AS current_user,
      current_setting('server_version') AS server_version,
      current_setting('server_version_num') AS server_version_num,
      clock_timestamp() AS database_time,
      pg_is_in_recovery() AS in_recovery
  `.execute(options.connection.db);
  const connection = connectionResult.rows[0];
  if (connection === undefined) {
    throw new Error('PostgreSQL connection check returned no row');
  }
  checks.push({
    name: 'database.connection',
    status: 'pass',
    details: {
      database: connection.current_database,
      user: connection.current_user,
      serverVersion: connection.server_version,
      inRecovery: connection.in_recovery,
    },
  });

  const roleClient = await options.connection.pool.connect();
  try {
    await validateRoleContract(roleClient, connection.current_user, {
      role: atodotrenRoles.ingestWriter,
      admin: false,
      inherit: true,
      set: false,
    });
  } finally {
    roleClient.release();
  }
  checks.push({
    name: 'database.roles',
    status: 'pass',
    details: {
      groupRoles: atodotrenGroupRoles,
      runtimeMembership: { admin: false, inherit: true, set: false },
    },
  });

  const serverMajor = Math.floor(Number(connection.server_version_num) / 10_000);
  if (
    !Number.isSafeInteger(serverMajor) ||
    serverMajor < supportedPostgresMajors.minimum ||
    serverMajor > supportedPostgresMajors.maximum
  ) {
    throw new Error(
      `Unsupported PostgreSQL major ${serverMajor}; supported majors are ${supportedPostgresMajors.minimum}-${supportedPostgresMajors.maximum}`,
    );
  }
  checks.push({
    name: 'database.version',
    status: 'pass',
    details: {
      major: serverMajor,
      minimum: supportedPostgresMajors.minimum,
      maximum: supportedPostgresMajors.maximum,
    },
  });

  const inventory = await readMigrationInventory(options.migrationsDirectory);
  const migrationResult = await sql<{ name: string; checksum: string }>`
    SELECT name, checksum
    FROM operations.schema_migration
    ORDER BY name
  `.execute(options.connection.db);
  const migrationState = reconcileMigrationState(inventory, migrationResult.rows);
  if (migrationState.pending.length > 0) {
    throw new Error(
      `Database has pending migrations: ${migrationState.pending.map((migration) => migration.name).join(', ')}`,
    );
  }
  checks.push({
    name: 'database.migrations',
    status: 'pass',
    details: {
      count: migrationState.applied.length,
      latest: migrationState.applied.at(-1)?.name ?? null,
    },
  });

  const permissionResult = await sql<PermissionRow>`
    SELECT
      schema_name,
      has_schema_privilege(current_user, schema_name, 'USAGE') AS has_usage,
      has_schema_privilege(current_user, schema_name, 'CREATE') AS has_create
    FROM unnest(ARRAY[${sql.join(runtimeSchemas)}]::text[]) AS schema_name
    ORDER BY schema_name
  `.execute(options.connection.db);
  const invalid = permissionResult.rows.filter((row) => !row.has_usage || row.has_create);
  if (invalid.length > 0) {
    throw new Error(
      `Runtime database role has invalid private-schema permissions: ${invalid
        .map((row) => row.schema_name)
        .join(', ')}`,
    );
  }
  const membership = await sql<{
    is_ingest_writer: boolean;
    api_usage: boolean;
    public_usage: boolean;
    public_create: boolean;
  }>`
    SELECT
      pg_has_role(current_user, ${atodotrenRoles.ingestWriter}, 'member') AS is_ingest_writer,
      has_schema_privilege(current_user, 'api', 'USAGE') AS api_usage,
      has_schema_privilege(current_user, 'public', 'USAGE') AS public_usage,
      has_schema_privilege(current_user, 'public', 'CREATE') AS public_create
  `.execute(options.connection.db);
  const role = membership.rows[0];
  if (
    role?.is_ingest_writer !== true ||
    role.api_usage ||
    role.public_usage ||
    role.public_create
  ) {
    throw new Error('Runtime database role is not the least-privilege Atodotren ingest writer');
  }
  await sql`SELECT checked_at FROM operations.database_health`.execute(options.connection.db);
  checks.push({
    name: 'database.permissions',
    status: 'pass',
    details: {
      role: atodotrenRoles.ingestWriter,
      schemaUsage: runtimeSchemas,
      apiUsage: false,
      schemaCreate: false,
      publicUsage: false,
      publicCreate: false,
    },
  });

  const skewMs = Math.abs(now().getTime() - connection.database_time.getTime());
  if (skewMs > options.maxClockSkewMs) {
    throw new Error(
      `Database clock differs from worker clock by ${skewMs}ms (limit ${options.maxClockSkewMs}ms)`,
    );
  }
  checks.push({
    name: 'clock.skew',
    status: 'pass',
    details: { skewMs, maximumMs: options.maxClockSkewMs },
  });

  const staticFeedResult = await sql<{
    id: string;
    sha256: string;
    source_url: string;
    fetched_at: Date;
    activated_at: Date;
    previous_feed_version_id: string | null;
    routes: string;
    mapped_routes: string;
    trips: string;
    mapped_trips: string;
    stops: string;
    mapped_stops: string;
  }>`
    SELECT
      active.id,
      active.sha256,
      active.source_url,
      active.fetched_at,
      active.activated_at,
      active.previous_feed_version_id,
      (SELECT count(*) FROM gtfs_static.route WHERE feed_version_id = active.id)::text AS routes,
      (SELECT count(*) FROM gtfs_static.route_line_map WHERE feed_version_id = active.id)::text AS mapped_routes,
      (SELECT count(*) FROM gtfs_static.trip WHERE feed_version_id = active.id)::text AS trips,
      (SELECT count(*) FROM gtfs_static.trip_pattern_map WHERE feed_version_id = active.id)::text AS mapped_trips,
      (SELECT count(*) FROM gtfs_static.stop WHERE feed_version_id = active.id)::text AS stops,
      (SELECT count(*) FROM gtfs_static.stop_station_map WHERE feed_version_id = active.id)::text AS mapped_stops
    FROM gtfs_static.current_feed_version AS active
    WHERE active.network_slug = 'madrid'
  `.execute(options.connection.db);
  const staticFeed = staticFeedResult.rows[0];
  if (staticFeed === undefined) {
    throw new Error('No valid active Madrid static-feed version exists; run worker import-static');
  }
  const routes = Number(staticFeed.routes);
  const trips = Number(staticFeed.trips);
  const stops = Number(staticFeed.stops);
  if (
    routes <= 0 || trips <= 0 || stops <= 0 ||
    Number(staticFeed.mapped_routes) !== routes ||
    Number(staticFeed.mapped_trips) !== trips ||
    Number(staticFeed.mapped_stops) !== stops
  ) {
    throw new Error(`Active Madrid static-feed version ${staticFeed.id} has incomplete stable-dimension mapping coverage`);
  }
  checks.push({
    name: 'feeds.static',
    status: 'pass',
    details: {
      network: 'madrid',
      versionId: staticFeed.id,
      checksum: staticFeed.sha256,
      source: new URL(staticFeed.source_url, 'file:///').protocol === 'file:' ? 'local-file' : new URL(staticFeed.source_url).hostname,
      fetchedAt: staticFeed.fetched_at,
      activatedAt: staticFeed.activated_at,
      ageMs: Math.max(0, now().getTime() - staticFeed.activated_at.getTime()),
      previousVersionId: staticFeed.previous_feed_version_id,
      counts: { routes, trips, stops },
      mappingCoverage: { routes, trips, stops },
    },
  });
  const latestPoll = await options.connection.pool.query<{
    captured_at: Date; feed_kind: string; feed_header_timestamp: string | null;
  }>(`
    SELECT captured_at, feed_kind, feed_header_timestamp::text
    FROM ingest.poll_run WHERE result_class = 'success'
    ORDER BY captured_at DESC LIMIT 1
  `);
  const latest = latestPoll.rows[0];
  const ageMs = latest === undefined ? null : Math.max(0, now().getTime() - latest.captured_at.getTime());
  checks.push({
    name: 'feeds.realtime',
    status: latest !== undefined && ageMs !== null && ageMs <= (options.realtime?.pollFreshnessMs ?? 120_000) ? 'pass' : 'deferred',
    details: {
      endpoints: options.realtime?.endpoints.map((endpoint) => ({
        kind: endpoint.kind, enabled: endpoint.enabled, host: new URL(endpoint.url).hostname,
      })) ?? [],
      latestSuccessfulPollAt: latest?.captured_at ?? null,
      latestFeedKind: latest?.feed_kind ?? null,
      latestFeedHeaderTimestamp: latest?.feed_header_timestamp ?? null,
      ageMs,
      freshnessLimitMs: options.realtime?.pollFreshnessMs ?? 120_000,
      fresh: ageMs !== null && ageMs <= (options.realtime?.pollFreshnessMs ?? 120_000),
    },
  });
  checks.push({
    name: 'spool.storage',
    status: options.realtime?.spool.writable === true ? 'pass' : 'deferred',
    details: options.realtime?.spool ?? { reason: 'Spool was not inspected' },
  });
  checks.push({
    name: 'heartbeat.configuration',
    status: options.realtime?.heartbeatConfigured === true ? 'pass' : 'deferred',
    details: { configured: options.realtime?.heartbeatConfigured ?? false },
  });

  return { ok: true, scope: 'milestone-2', checks };
}
