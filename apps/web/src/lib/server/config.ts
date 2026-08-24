import "server-only";

import type { DataMode } from "@/lib/domain/contracts";

export interface WebServerConfig {
  readonly mode: DataMode;
  readonly fixtureScenario: string;
  readonly databaseUrl: string | null;
  readonly databaseSslMode: "disable" | "require";
  readonly poolMax: number;
  readonly statementTimeoutMs: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getWebServerConfig(env: NodeJS.ProcessEnv = process.env): WebServerConfig {
  const rawMode = env.WEB_DATA_MODE ?? "postgres";
  if (rawMode !== "fixture" && rawMode !== "postgres") throw new Error(`Unsupported WEB_DATA_MODE: ${rawMode}`);
  if (rawMode === "fixture" && env.NODE_ENV === "production" && env.WEB_ALLOW_FIXTURE_PRODUCTION !== "true") {
    throw new Error("Fixture data mode is forbidden in production without WEB_ALLOW_FIXTURE_PRODUCTION=true");
  }
  const databaseUrl = env.WEB_DATABASE_URL?.trim() || null;
  if (rawMode === "postgres" && databaseUrl === null) throw new Error("WEB_DATABASE_URL is required in postgres mode");
  const sslMode = env.WEB_DATABASE_SSL_MODE ?? "require";
  if (sslMode !== "disable" && sslMode !== "require") throw new Error("WEB_DATABASE_SSL_MODE must be disable or require");
  return {
    mode: rawMode,
    fixtureScenario: env.WEB_FIXTURE_SCENARIO?.trim() || "healthy",
    databaseUrl,
    databaseSslMode: sslMode,
    poolMax: positiveInteger(env.WEB_DATABASE_POOL_MAX, 5),
    statementTimeoutMs: positiveInteger(env.WEB_DATABASE_STATEMENT_TIMEOUT_MS, 5_000),
  };
}
