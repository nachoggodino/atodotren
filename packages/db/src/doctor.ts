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
  readonly scope: 'milestone-0';
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorOptions {
  readonly connection: DatabaseConnection;
  readonly migrationsDirectory: string;
  readonly maxClockSkewMs: number;
  readonly now?: () => Date;
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

  checks.push({
    name: 'feeds',
    status: 'deferred',
    details: { reason: 'Feed access begins in Milestone 1 and is not required in Milestone 0' },
  });
  checks.push({
    name: 'spool.storage',
    status: 'deferred',
    details: { reason: 'The bounded outage spool begins in Milestone 2' },
  });

  return { ok: true, scope: 'milestone-0', checks };
}
