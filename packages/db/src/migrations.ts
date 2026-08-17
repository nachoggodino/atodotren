import type { PoolClient } from 'pg';

import { createDatabaseConnection } from './connection.js';
import { atodotrenRoles } from './contract.js';
import {
  readMigrationInventory,
  reconcileMigrationState,
  type AppliedMigration,
} from './migration-inventory.js';
import { validateRoleContract } from './roles.js';
import type { DatabaseConnectionOptions, DatabaseLogSink } from './types.js';

const advisoryLockId = '7811417130112024';
export const migrationOwnerRole = atodotrenRoles.migrationAdmin;

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

interface MigrationOptions {
  readonly connection: DatabaseConnectionOptions;
  readonly migrationsDirectory: string;
  readonly logger?: DatabaseLogSink;
}

async function appliedMigrations(client: PoolClient): Promise<readonly AppliedMigration[]> {
  const relation = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('operations.schema_migration') IS NOT NULL AS exists",
  );
  if (relation.rows[0]?.exists !== true) {
    return [];
  }
  const result = await client.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM operations.schema_migration ORDER BY name',
  );
  return result.rows;
}

async function assumeMigrationOwner(client: PoolClient, local: boolean): Promise<void> {
  const identity = await client.query<{ session_user: string }>('SELECT session_user');
  const sessionUser = identity.rows[0]?.session_user;
  if (sessionUser === undefined) {
    throw new Error('Migration session identity could not be determined');
  }
  await validateRoleContract(client, sessionUser, {
    role: migrationOwnerRole,
    admin: false,
    inherit: false,
    set: true,
  });

  await client.query(`${local ? 'SET LOCAL' : 'SET'} ROLE ${migrationOwnerRole}`);
  const assumed = await client.query<{ current_user: string; session_user: string }>(
    'SELECT current_user, session_user',
  );
  if (assumed.rows[0]?.current_user !== migrationOwnerRole) {
    throw new Error(`Failed to assume required migration owner role ${migrationOwnerRole}`);
  }
}

export async function migrateToLatest(options: MigrationOptions): Promise<MigrationResult> {
  const files = await readMigrationInventory(options.migrationsDirectory);
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
    const state = reconcileMigrationState(files, existing);
    const existingByName = new Map(existing.map((migration) => [migration.name, migration.checksum]));
    const lastAppliedSequence = state.applied.at(-1)?.sequence;

    for (const migration of files) {
      const existingChecksum = existingByName.get(migration.name);
      if (existingChecksum !== undefined) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(`Applied migration ${migration.name} has been modified`);
        }
        alreadyApplied.push(migration.name);
        continue;
      }
      if (lastAppliedSequence !== undefined && migration.sequence < lastAppliedSequence) {
        throw new Error(
          `Migration ${migration.name} sorts before the latest already-applied sequence`,
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
