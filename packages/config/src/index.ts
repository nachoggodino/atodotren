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

export interface RealtimeEndpointConfig {
  readonly enabled: boolean;
  readonly url: string;
}

export interface RealtimeConfig {
  readonly tripUpdates: RealtimeEndpointConfig;
  readonly vehiclePositions: RealtimeEndpointConfig;
  readonly serviceAlerts: RealtimeEndpointConfig;
  readonly requestTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly cycleIntervalMs: number;
  readonly alertIntervalMs: number;
}

export interface SpoolConfig {
  readonly path: string;
  readonly maxBytes: number;
  readonly maxBacklogMs: number;
}

export interface TelegramConfig {
  readonly botToken: string;
  readonly chatId: string;
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user?: string;
  readonly password?: string;
  readonly from: string;
  readonly to: string;
}

export interface OperationsConfig {
  readonly heartbeatUrl?: string;
  readonly telegram?: TelegramConfig;
  readonly smtp?: SmtpConfig;
  readonly failureThreshold: number;
  readonly staleAfterMs: number;
  readonly matchingRateMinimum: number;
  readonly matchingRateRecoveryMinimum: number;
  readonly matchingRecoveryThreshold: number;
  readonly malformedRateMaximum: number;
  readonly spoolWarningRatio: number;
}

export interface AppConfig {
  readonly nodeEnvironment: NodeEnvironment;
  readonly logLevel: LogLevel;
  readonly database: DatabaseConfig;
  readonly migrationDatabase: DatabaseConfig;
  readonly realtime: RealtimeConfig;
  readonly spool: SpoolConfig;
  readonly operations: OperationsConfig;
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

function boundedInteger(
  environment: Environment,
  key: string,
  fallback: number,
  maximum: number,
  issues: string[],
): number {
  const value = positiveInteger(environment, key, fallback, issues);
  if (value > maximum) {
    issues.push(`${key} must be no greater than ${maximum}`);
    return fallback;
  }
  return value;
}

function booleanValue(environment: Environment, key: string, fallback: boolean, issues: string[]): boolean {
  const raw = environment[key];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  issues.push(`${key} must be true or false`);
  return fallback;
}

function httpUrl(environment: Environment, key: string, fallback: string, optional: boolean, allowHttp: boolean, issues: string[]): string | undefined {
  const raw = environment[key]?.trim() ?? fallback;
  if (raw === '' && optional) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (allowHttp || ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) {
      issues.push(`${key} must use HTTPS or loopback HTTP`);
    }
  } catch {
    issues.push(`${key} must be a valid URL`);
  }
  return raw;
}

function ratio(environment: Environment, key: string, fallback: number, issues: string[]): number {
  const raw = environment[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    issues.push(`${key} must be a number between 0 and 1`);
    return fallback;
  }
  return value;
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

  const allowHttp = nodeEnvironment === 'test';
  const tripUpdatesUrl = httpUrl(environment, 'GTFS_RT_TRIP_UPDATES_URL', 'https://gtfsrt.renfe.com/trip_updates.pb', false, allowHttp, issues) ?? '';
  const vehiclePositionsUrl = httpUrl(environment, 'GTFS_RT_VEHICLE_POSITIONS_URL', 'https://gtfsrt.renfe.com/vehicle_positions.pb', false, allowHttp, issues) ?? '';
  const serviceAlertsUrl = httpUrl(environment, 'GTFS_RT_SERVICE_ALERTS_URL', 'https://gtfsrt.renfe.com/alerts.pb', false, allowHttp, issues) ?? '';
  const realtime: RealtimeConfig = {
    tripUpdates: { enabled: booleanValue(environment, 'GTFS_RT_TRIP_UPDATES_ENABLED', true, issues), url: tripUpdatesUrl },
    vehiclePositions: { enabled: booleanValue(environment, 'GTFS_RT_VEHICLE_POSITIONS_ENABLED', true, issues), url: vehiclePositionsUrl },
    serviceAlerts: { enabled: booleanValue(environment, 'GTFS_RT_SERVICE_ALERTS_ENABLED', true, issues), url: serviceAlertsUrl },
    requestTimeoutMs: boundedInteger(environment, 'GTFS_RT_REQUEST_TIMEOUT_MS', 10_000, 60_000, issues),
    maxResponseBytes: boundedInteger(environment, 'GTFS_RT_MAX_RESPONSE_BYTES', 32 * 1024 * 1024, 256 * 1024 * 1024, issues),
    cycleIntervalMs: boundedInteger(environment, 'GTFS_RT_CYCLE_INTERVAL_MS', 30_000, 3_600_000, issues),
    alertIntervalMs: boundedInteger(environment, 'GTFS_RT_ALERT_INTERVAL_MS', 60_000, 3_600_000, issues),
  };
  const spool: SpoolConfig = {
    path: environment.SQLITE_SPOOL_PATH?.trim() || '/tmp/atodotren/realtime-spool.sqlite',
    maxBytes: boundedInteger(environment, 'SQLITE_SPOOL_MAX_BYTES', 1024 * 1024 * 1024, 10 * 1024 * 1024 * 1024, issues),
    maxBacklogMs: boundedInteger(environment, 'SQLITE_SPOOL_MAX_BACKLOG_MS', 48 * 60 * 60 * 1_000, 48 * 60 * 60 * 1_000, issues),
  };
  const heartbeatUrl = httpUrl(environment, 'HEARTBEAT_URL', '', true, allowHttp, issues);
  const telegramToken = environment.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  const telegramChatId = environment.TELEGRAM_CHAT_ID?.trim() || undefined;
  if ((telegramToken === undefined) !== (telegramChatId === undefined)) {
    issues.push('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be configured together');
  }
  const smtpHost = environment.SMTP_HOST?.trim() || undefined;
  const smtpFrom = environment.SMTP_FROM?.trim() || undefined;
  const smtpTo = environment.SMTP_TO?.trim() || undefined;
  const smtpUser = environment.SMTP_USER?.trim() || undefined;
  const smtpPassword = environment.SMTP_PASSWORD || undefined;
  if (smtpHost !== undefined && (smtpFrom === undefined || smtpTo === undefined)) {
    issues.push('SMTP_HOST requires SMTP_FROM and SMTP_TO');
  }
  if ((smtpUser === undefined) !== (smtpPassword === undefined)) {
    issues.push('SMTP_USER and SMTP_PASSWORD must be configured together');
  }
  const matchingRateMinimum = ratio(environment, 'INGEST_MATCHING_RATE_MINIMUM', 0.02, issues);
  const matchingRateRecoveryMinimum = ratio(environment, 'INGEST_MATCHING_RATE_RECOVERY_MINIMUM', 0.05, issues);
  if (matchingRateRecoveryMinimum <= matchingRateMinimum) {
    issues.push('INGEST_MATCHING_RATE_RECOVERY_MINIMUM must be greater than INGEST_MATCHING_RATE_MINIMUM');
  }
  const operations: OperationsConfig = {
    ...(heartbeatUrl === undefined ? {} : { heartbeatUrl }),
    ...(telegramToken === undefined || telegramChatId === undefined ? {} : {
      telegram: { botToken: telegramToken, chatId: telegramChatId },
    }),
    ...(smtpHost === undefined || smtpFrom === undefined || smtpTo === undefined ? {} : {
      smtp: {
        host: smtpHost,
        port: boundedInteger(environment, 'SMTP_PORT', 587, 65_535, issues),
        secure: booleanValue(environment, 'SMTP_SECURE', false, issues),
        ...(smtpUser === undefined ? {} : { user: smtpUser }),
        ...(smtpPassword === undefined ? {} : { password: smtpPassword }),
        from: smtpFrom,
        to: smtpTo,
      },
    }),
    failureThreshold: boundedInteger(environment, 'INGEST_ALERT_FAILURE_THRESHOLD', 3, 100, issues),
    staleAfterMs: boundedInteger(environment, 'INGEST_STALE_AFTER_MS', 120_000, 86_400_000, issues),
    matchingRateMinimum,
    matchingRateRecoveryMinimum,
    matchingRecoveryThreshold: boundedInteger(environment, 'INGEST_MATCHING_RECOVERY_THRESHOLD', 3, 100, issues),
    malformedRateMaximum: ratio(environment, 'INGEST_MALFORMED_RATE_MAXIMUM', 0.25, issues),
    spoolWarningRatio: ratio(environment, 'SQLITE_SPOOL_WARNING_RATIO', 0.75, issues),
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

  return { ...shared, database, migrationDatabase, realtime, spool, operations };
}

export * from './preflight.js';
