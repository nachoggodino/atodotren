export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type NodeEnvironment = 'development' | 'test' | 'production';
export type DatabaseSslMode = 'disable' | 'require' | 'verify-full';

export interface DatabaseConfig {
  readonly url: string;
  readonly sslMode: DatabaseSslMode;
  readonly caCertificatePath?: string;
  readonly poolMax: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly applicationName: string;
}

export interface AppConfig {
  readonly nodeEnvironment: NodeEnvironment;
  readonly logLevel: LogLevel;
  readonly database: DatabaseConfig;
  readonly migrationDatabase: DatabaseConfig;
  readonly doctorMaxClockSkewMs: number;
  readonly shutdownTimeoutMs: number;
}

export class ConfigError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid environment configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

const nodeEnvironments = ['development', 'test', 'production'] as const;
const logLevels = ['debug', 'info', 'warn', 'error'] as const;
const sslModes = ['disable', 'require', 'verify-full'] as const;

function enumValue<const T extends readonly string[]>(
  environment: Environment,
  key: string,
  values: T,
  fallback: T[number],
  issues: string[],
): T[number] {
  const value = environment[key] ?? fallback;
  if ((values as readonly string[]).includes(value)) {
    return value;
  }
  issues.push(`${key} must be one of ${values.join(', ')}`);
  return fallback;
}

function positiveInteger(
  environment: Environment,
  key: string,
  fallback: number,
  issues: string[],
): number {
  const raw = environment[key];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    issues.push(`${key} must be a positive integer`);
    return fallback;
  }
  return parsed;
}

function databaseUrl(environment: Environment, key: string, issues: string[]): string {
  const raw = environment[key];
  if (raw === undefined || raw.trim() === '') {
    issues.push(`${key} is required`);
    return 'postgresql://invalid.invalid/invalid';
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
      issues.push(`${key} must use the postgres:// or postgresql:// protocol`);
    }
    if (parsed.hostname === '') {
      issues.push(`${key} must include a hostname`);
    }
    if (parsed.pathname === '' || parsed.pathname === '/') {
      issues.push(`${key} must include a database name`);
    }
  } catch {
    issues.push(`${key} must be a valid PostgreSQL connection URL`);
  }
  return raw;
}

function connectionConfig(
  environment: Environment,
  url: string,
  applicationName: string,
  issues: string[],
): DatabaseConfig {
  const sslMode = enumValue(environment, 'DATABASE_SSL_MODE', sslModes, 'disable', issues);
  const caCertificatePath = environment.DATABASE_CA_CERT_PATH?.trim() || undefined;
  if (caCertificatePath !== undefined && sslMode !== 'verify-full') {
    issues.push('DATABASE_CA_CERT_PATH requires DATABASE_SSL_MODE=verify-full');
  }
  if (sslMode === 'verify-full' && caCertificatePath === undefined) {
    issues.push('DATABASE_SSL_MODE=verify-full requires DATABASE_CA_CERT_PATH');
  }

  return {
    url,
    sslMode,
    ...(caCertificatePath === undefined ? {} : { caCertificatePath }),
    poolMax: positiveInteger(environment, 'DATABASE_POOL_MAX', 5, issues),
    connectionTimeoutMs: positiveInteger(
      environment,
      'DATABASE_CONNECTION_TIMEOUT_MS',
      5_000,
      issues,
    ),
    idleTimeoutMs: positiveInteger(environment, 'DATABASE_IDLE_TIMEOUT_MS', 30_000, issues),
    statementTimeoutMs: positiveInteger(
      environment,
      'DATABASE_STATEMENT_TIMEOUT_MS',
      30_000,
      issues,
    ),
    applicationName,
  };
}

export function loadConfig(environment: Environment = process.env): AppConfig {
  const issues: string[] = [];
  const runtimeUrl = databaseUrl(environment, 'DATABASE_URL', issues);
  const rawMigrationUrl = environment.MIGRATION_DATABASE_URL;
  const migrationUrl = rawMigrationUrl === undefined ? runtimeUrl : rawMigrationUrl;
  if (rawMigrationUrl !== undefined) {
    databaseUrl({ MIGRATION_DATABASE_URL: migrationUrl }, 'MIGRATION_DATABASE_URL', issues);
  }

  const nodeEnvironment = enumValue(
    environment,
    'NODE_ENV',
    nodeEnvironments,
    'development',
    issues,
  );
  const logLevel = enumValue(environment, 'LOG_LEVEL', logLevels, 'info', issues);
  const shared = {
    nodeEnvironment,
    logLevel,
    doctorMaxClockSkewMs: positiveInteger(
      environment,
      'DOCTOR_MAX_CLOCK_SKEW_MS',
      5_000,
      issues,
    ),
    shutdownTimeoutMs: positiveInteger(environment, 'SHUTDOWN_TIMEOUT_MS', 10_000, issues),
  };

  const database = connectionConfig(environment, runtimeUrl, 'atodotren-worker', issues);
  const migrationDatabase: DatabaseConfig = {
    ...database,
    url: migrationUrl,
    applicationName: 'atodotren-migrations',
  };

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return { ...shared, database, migrationDatabase };
}

export * from './preflight.js';
