import { readFile } from 'node:fs/promises';

import { Kysely, PostgresDialect } from 'kysely';
import { Pool, type PoolConfig } from 'pg';

import type { Database, DatabaseConnectionOptions, DatabaseLogSink } from './types.js';

export interface DatabaseConnection {
  readonly db: Kysely<Database>;
  readonly pool: Pool;
  close(): Promise<void>;
}

async function sslConfig(
  options: DatabaseConnectionOptions,
): Promise<PoolConfig['ssl']> {
  if (options.sslMode === 'disable') {
    return false;
  }
  if (options.sslMode === 'require') {
    return { rejectUnauthorized: false };
  }
  if (options.caCertificatePath === undefined) {
    throw new Error('verify-full TLS requires a CA certificate path');
  }
  const ca = await readFile(options.caCertificatePath, 'utf8');
  return { ca, rejectUnauthorized: true };
}

export async function createDatabaseConnection(
  options: DatabaseConnectionOptions,
  logger?: DatabaseLogSink,
): Promise<DatabaseConnection> {
  const ssl = await sslConfig(options);
  const pool = new Pool({
    connectionString: options.url,
    ssl,
    max: options.poolMax,
    connectionTimeoutMillis: options.connectionTimeoutMs,
    idleTimeoutMillis: options.idleTimeoutMs,
    statement_timeout: options.statementTimeoutMs,
    application_name: options.applicationName,
  });

  pool.on('error', (error) => {
    logger?.error('database.pool.error', 'Idle PostgreSQL client failed', { error });
  });
  pool.on('connect', () => {
    logger?.debug('database.pool.connected', 'PostgreSQL pool opened a connection');
  });

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
  let closed = false;

  return {
    db,
    pool,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await db.destroy();
      // Kysely initializes its dialect lazily. Migration code deliberately uses
      // the exposed pg Pool for session-scoped advisory locks, so the dialect
      // may never initialize and db.destroy() then has no driver to tear down.
      if (!pool.ending) {
        await pool.end();
      }
    },
  };
}
