import { sql } from 'kysely';

import type { DatabaseConnection } from './connection.js';

const requiredSchemas = [
  'gtfs_static',
  'ingest',
  'core',
  'analytics',
  'operations',
] as const;
const supportedPostgresMajors = { minimum: 16, maximum: 18 } as const;
const ingestWriterRole = 'atodotren_ingest_writer';
const requiredGroupRoles = [
  'atodotren_migration_admin',
  ingestWriterRole,
  'atodotren_web_reader',
  'atodotren_backup_reader',
  'atodotren_monitor_reader',
] as const;

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

interface DoctorOptions {
  readonly connection: DatabaseConnection;
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

interface RoleSecurityRow {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
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

  const groupRoleResult = await sql<RoleSecurityRow>`
    SELECT
      rolname,
      rolcanlogin,
      rolsuper,
      rolcreatedb,
      rolcreaterole,
      rolreplication,
      rolbypassrls
    FROM pg_roles
    WHERE rolname = ANY(ARRAY[${sql.join(requiredGroupRoles)}]::text[])
    ORDER BY rolname
  `.execute(options.connection.db);
  const unsafeRoles = groupRoleResult.rows.filter(
    (role) =>
      role.rolcanlogin ||
      role.rolsuper ||
      role.rolcreatedb ||
      role.rolcreaterole ||
      role.rolreplication ||
      role.rolbypassrls,
  );
  if (groupRoleResult.rows.length !== requiredGroupRoles.length || unsafeRoles.length > 0) {
    throw new Error('Required Atodotren group roles are missing or have unsafe attributes');
  }

  const runtimeMembership = await sql<{
    valid_membership: boolean;
  }>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_auth_members membership
      JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
      JOIN pg_roles member_role ON member_role.oid = membership.member
      WHERE granted_role.rolname = ${ingestWriterRole}
        AND member_role.rolname = current_user
        AND NOT membership.admin_option
        AND membership.inherit_option
        AND NOT membership.set_option
    ) AS valid_membership
  `.execute(options.connection.db);
  if (runtimeMembership.rows[0]?.valid_membership !== true) {
    throw new Error('Runtime login has unsafe Atodotren ingest-writer membership options');
  }
  checks.push({
    name: 'database.roles',
    status: 'pass',
    details: {
      groupRoles: requiredGroupRoles,
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

  const migrationResult = await sql<{ migration_count: number; latest_migration: string | null }>`
    SELECT count(*)::integer AS migration_count, max(name) AS latest_migration
    FROM operations.schema_migration
  `.execute(options.connection.db);
  const migration = migrationResult.rows[0];
  if (migration === undefined || migration.migration_count < 1) {
    throw new Error('No applied database migrations were found');
  }
  checks.push({
    name: 'database.migrations',
    status: 'pass',
    details: {
      count: migration.migration_count,
      latest: migration.latest_migration,
    },
  });

  const permissionResult = await sql<PermissionRow>`
    SELECT
      schema_name,
      has_schema_privilege(current_user, schema_name, 'USAGE') AS has_usage,
      has_schema_privilege(current_user, schema_name, 'CREATE') AS has_create
    FROM unnest(ARRAY[${sql.join(requiredSchemas)}]::text[]) AS schema_name
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
      pg_has_role(current_user, ${ingestWriterRole}, 'member') AS is_ingest_writer,
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
      role: ingestWriterRole,
      schemaUsage: requiredSchemas,
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
