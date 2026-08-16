import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { PoolClient } from 'pg';

import { createDatabaseConnection } from './connection.js';
import type { DatabaseConnectionOptions, DatabaseLogSink } from './types.js';

const migrationFilePattern = /^\d{4}_[a-z0-9_]+\.sql$/;
const advisoryLockId = '7811417130112024';
export const migrationOwnerRole = 'atodotren_migration_admin';

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

interface MigrationOptions {
  readonly connection: DatabaseConnectionOptions;
  readonly migrationsDirectory: string;
  readonly logger?: DatabaseLogSink;
}

interface MigrationFile {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

async function migrationFiles(directory: string): Promise<readonly MigrationFile[]> {
  const absoluteDirectory = resolve(directory);
  const names = (await readdir(absoluteDirectory))
    .filter((name) => migrationFilePattern.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (names.length === 0) {
    throw new Error(`No migration files found in ${absoluteDirectory}`);
  }

  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(resolve(absoluteDirectory, name), 'utf8');
      return {
        name,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
}

async function appliedMigrations(client: PoolClient): Promise<ReadonlyMap<string, string>> {
  const relation = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('operations.schema_migration') IS NOT NULL AS exists",
  );
  if (relation.rows[0]?.exists !== true) {
    return new Map();
  }
  const result = await client.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM operations.schema_migration ORDER BY name',
  );
  return new Map(result.rows.map((row) => [row.name, row.checksum]));
}

async function assumeMigrationOwner(client: PoolClient, local: boolean): Promise<void> {
  const membership = await client.query<{ valid_membership: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_auth_members membership
      JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
      JOIN pg_roles member_role ON member_role.oid = membership.member
      WHERE granted_role.rolname = '${migrationOwnerRole}'
        AND member_role.rolname = session_user
        AND NOT membership.admin_option
        AND NOT membership.inherit_option
        AND membership.set_option
    ) AS valid_membership
  `);
  if (membership.rows[0]?.valid_membership !== true) {
    throw new Error(
      `Migration login needs ${migrationOwnerRole} membership with ADMIN FALSE, INHERIT FALSE, SET TRUE`,
    );
  }

  await client.query(`${local ? 'SET LOCAL' : 'SET'} ROLE ${migrationOwnerRole}`);
  const assumed = await client.query<{ current_user: string; session_user: string }>(
    'SELECT current_user, session_user',
  );
  if (assumed.rows[0]?.current_user !== migrationOwnerRole) {
    throw new Error(`Failed to assume required migration owner role ${migrationOwnerRole}`);
  }
}

export async function migrateToLatest(options: MigrationOptions): Promise<MigrationResult> {
  const files = await migrationFiles(options.migrationsDirectory);
  const connection = await createDatabaseConnection(options.connection, options.logger);
  let client: PoolClient | undefined;
  let locked = false;
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  try {
    client = await connection.pool.connect();
    await client.query('SELECT pg_advisory_lock($1::bigint)', [advisoryLockId]);
    locked = true;
    await assumeMigrationOwner(client, false);
    const existing = await appliedMigrations(client);
    const availableNames = new Set(files.map((migration) => migration.name));
    for (const existingName of existing.keys()) {
      if (!availableNames.has(existingName)) {
        throw new Error(`Applied migration ${existingName} is missing from the repository`);
      }
    }
    const lastAppliedName = [...existing.keys()].at(-1);

    for (const migration of files) {
      const existingChecksum = existing.get(migration.name);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(`Applied migration ${migration.name} has been modified`);
        }
        alreadyApplied.push(migration.name);
        continue;
      }
      if (lastAppliedName !== undefined && migration.name < lastAppliedName) {
        throw new Error(
          `Migration ${migration.name} sorts before already-applied migration ${lastAppliedName}`,
        );
      }

      options.logger?.debug('migration.started', 'Applying SQL migration', {
        migration: migration.name,
      });
      await client.query('BEGIN');
      try {
        await assumeMigrationOwner(client, true);
        await client.query(migration.sql);
        const owner = await client.query<{ current_user: string }>('SELECT current_user');
        if (owner.rows[0]?.current_user !== migrationOwnerRole) {
          throw new Error(
            `Migration ${migration.name} changed ownership context away from ${migrationOwnerRole}`,
          );
        }
        await client.query(
          'INSERT INTO operations.schema_migration (name, checksum) VALUES ($1, $2)',
          [migration.name, migration.checksum],
        );
        await client.query('COMMIT');
        applied.push(migration.name);
        options.logger?.debug('migration.completed', 'SQL migration applied', {
          migration: migration.name,
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    return { applied, alreadyApplied };
  } finally {
    try {
      if (client !== undefined && locked) {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [advisoryLockId]);
      }
    } finally {
      if (client !== undefined) {
        await client.query('RESET ROLE').catch(() => undefined);
      }
      client?.release();
      await connection.close();
    }
  }
}
