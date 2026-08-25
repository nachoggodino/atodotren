import "server-only";

import type { DataMode } from "@/lib/domain/contracts";

export interface WebServerConfig {
  readonly mode: DataMode;
  readonly fixtureScenario: string;
  readonly fixtureScenarioOverridesEnabled: boolean;
  readonly databaseUrl: string | null;
  readonly databaseSslMode: "disable" | "verify-full";
  readonly databaseSslCa: string | null;
  readonly poolMax: number;
  readonly statementTimeoutMs: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received: ${value}`);
  return parsed;
}

function booleanFlag(value: string | undefined): boolean {
  return value === "true";
}

export function getWebServerConfig(env: NodeJS.ProcessEnv = process.env): WebServerConfig {
  const rawMode = env.WEB_DATA_MODE ?? "postgres";
  if (rawMode !== "fixture" && rawMode !== "postgres") throw new Error(`Unsupported WEB_DATA_MODE: ${rawMode}`);
  if (rawMode === "fixture" && env.NODE_ENV === "production" && !booleanFlag(env.WEB_ALLOW_FIXTURE_PRODUCTION)) {
    throw new Error("Fixture data mode is forbidden in production without WEB_ALLOW_FIXTURE_PRODUCTION=true");
  }

  const databaseUrl = env.WEB_DATABASE_URL?.trim() || null;
  if (rawMode === "postgres" && databaseUrl === null) throw new Error("WEB_DATABASE_URL is required in postgres mode");

  const sslMode = env.WEB_DATABASE_SSL_MODE ?? "verify-full";
  if (sslMode !== "disable" && sslMode !== "verify-full") {
    throw new Error("WEB_DATABASE_SSL_MODE must be disable or verify-full");
  }
  if (env.NODE_ENV === "production" && rawMode === "postgres" && sslMode === "disable" && !booleanFlag(env.WEB_ALLOW_INSECURE_DATABASE_TLS)) {
    throw new Error("Database TLS cannot be disabled in production without WEB_ALLOW_INSECURE_DATABASE_TLS=true");
  }

  const ca = env.WEB_DATABASE_SSL_CA?.trim();
  return {
    mode: rawMode,
    fixtureScenario: env.WEB_FIXTURE_SCENARIO?.trim() || "healthy",
    fixtureScenarioOverridesEnabled: booleanFlag(env.WEB_ENABLE_FIXTURE_SCENARIOS),
    databaseUrl,
    databaseSslMode: sslMode,
    databaseSslCa: ca === undefined || ca === "" ? null : ca.replace(/\\n/g, "\n"),
    poolMax: positiveInteger(env.WEB_DATABASE_POOL_MAX, 5),
    statementTimeoutMs: positiveInteger(env.WEB_DATABASE_STATEMENT_TIMEOUT_MS, 5_000),
  };
}
