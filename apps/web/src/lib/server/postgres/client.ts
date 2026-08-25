import "server-only";

import { Pool, type QueryResultRow } from "pg";
import type { WebServerConfig } from "../config";

export type RawPostgresRow = Readonly<Record<string, unknown>>;

export interface PostgresClient {
  query(text: string, values?: readonly unknown[]): Promise<readonly RawPostgresRow[]>;
  close(): Promise<void>;
}

export function createPostgresClient(config: WebServerConfig): PostgresClient {
  const ssl = config.databaseSslMode === "disable"
    ? false
    : {
        rejectUnauthorized: true,
        ...(config.databaseSslCa === null ? {} : { ca: config.databaseSslCa }),
      };
  const pool = new Pool({
    connectionString: config.databaseUrl ?? undefined,
    ssl,
    max: config.poolMax,
    statement_timeout: config.statementTimeoutMs,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: "atodotren-web",
  });

  return {
    async query(text, values = []) {
      const result = await pool.query<QueryResultRow>(text, [...values]);
      return result.rows;
    },
    async close() {
      await pool.end();
    },
  };
}
