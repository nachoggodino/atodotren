import { ConfigError, loadConfig, type DatabaseConfig, type LogLevel } from '@atodotren/config';

export interface TelegramOperationsConfig {
  readonly enabled: boolean;
  readonly botToken?: string;
  readonly allowedUserId?: string;
  readonly privateChatId?: string;
  readonly apiBaseUrl: string;
  readonly database: DatabaseConfig;
  readonly logLevel: LogLevel;
  readonly shutdownTimeoutMs: number;
  readonly pollTimeoutSeconds: number;
  readonly reportVersion: string;
  readonly digestReadyMinute: number;
  readonly digestTargetMinute: number;
  readonly digestBlockedMinute: number;
  readonly callbackTtlMs: number;
  readonly deliveryRetentionDays: number;
  readonly thresholds: {
    readonly durableIngestionStaleMs: number;
    readonly matchingRateMinimum: number;
    readonly matchingRateRecoveryMinimum: number;
    readonly matchingConsecutive: number;
    readonly malformedRateMaximum: number;
    readonly malformedConsecutive: number;
    readonly spoolBacklogMs: number;
    readonly postgresConsecutive: number;
    readonly cpuRatio: number;
    readonly cpuDurationMs: number;
    readonly memoryRatio: number;
    readonly memoryDurationMs: number;
    readonly diskWarningRatio: number;
    readonly diskCriticalRatio: number;
    readonly staticAgeDays: number;
  };
  readonly hostMetrics: {
    readonly enabled: boolean;
    readonly procPath?: string;
    readonly rootPath?: string;
  };
}

type Environment = Readonly<Record<string, string | undefined>>;

function bool(environment: Environment, key: string, fallback: boolean, issues: string[]): boolean {
  const value = environment[key]?.trim();
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  issues.push(`${key} must be true or false`);
  return fallback;
}

function integer(environment: Environment, key: string, fallback: number, minimum: number, maximum: number, issues: string[]): number {
  const value = environment[key]?.trim();
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    issues.push(`${key} must be an integer from ${minimum} through ${maximum}`);
    return fallback;
  }
  return parsed;
}

function ratio(environment: Environment, key: string, fallback: number, issues: string[]): number {
  const value = environment[key]?.trim();
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    issues.push(`${key} must be a number between 0 and 1`);
    return fallback;
  }
  return parsed;
}

function numericId(environment: Environment, key: string, required: boolean, issues: string[]): string | undefined {
  const value = environment[key]?.trim();
  if (value === undefined || value === '') {
    if (required) issues.push(`${key} is required when Telegram operations are enabled`);
    return undefined;
  }
  if (!/^-?\d{1,20}$/u.test(value)) {
    issues.push(`${key} must be a numeric Telegram identifier`);
    return undefined;
  }
  return value;
}

function minuteOfDay(environment: Environment, key: string, fallback: string, issues: string[]): number {
  const value = environment[key]?.trim() || fallback;
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) {
    issues.push(`${key} must use HH:MM in Europe/Madrid`);
    return 0;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    issues.push(`${key} must be a valid 24-hour time`);
    return 0;
  }
  return hour * 60 + minute;
}

function apiUrl(environment: Environment, nodeEnvironment: string, issues: string[]): string {
  const raw = environment.TELEGRAM_API_BASE_URL?.trim() || 'https://api.telegram.org';
  try {
    const parsed = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '[::1]', 'fake-telegram'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(nodeEnvironment === 'test' && parsed.protocol === 'http:' && loopback)) {
      issues.push('TELEGRAM_API_BASE_URL must use HTTPS except for test-only loopback/fake Telegram HTTP');
    }
    return raw.replace(/\/$/u, '');
  } catch {
    issues.push('TELEGRAM_API_BASE_URL must be a valid URL');
    return 'https://api.telegram.org';
  }
}

export function loadTelegramOperationsConfig(environment: Environment = process.env): TelegramOperationsConfig {
  const baseEnvironment = { ...environment, TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined };
  const app = loadConfig(baseEnvironment);
  const issues: string[] = [];
  const enabled = bool(environment, 'TELEGRAM_OPERATIONS_ENABLED', false, issues);
  const botToken = environment.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  if (enabled && botToken === undefined) issues.push('TELEGRAM_BOT_TOKEN is required when Telegram operations are enabled');
  if (botToken !== undefined && botToken.length > 256) issues.push('TELEGRAM_BOT_TOKEN is unexpectedly long');
  const allowedUserId = numericId(environment, 'TELEGRAM_ALLOWED_USER_ID', enabled, issues);
  const privateChatId = numericId(environment, 'TELEGRAM_PRIVATE_CHAT_ID', enabled, issues);
  const apiBaseUrl = apiUrl(environment, app.nodeEnvironment, issues);
  const digestReadyMinute = minuteOfDay(environment, 'TELEGRAM_DIGEST_READY_TIME', '04:00', issues);
  const digestTargetMinute = minuteOfDay(environment, 'TELEGRAM_DIGEST_TARGET_TIME', '05:00', issues);
  const digestBlockedMinute = minuteOfDay(environment, 'TELEGRAM_DIGEST_BLOCKED_TIME', '06:30', issues);
  if (!(digestReadyMinute < digestTargetMinute && digestTargetMinute < digestBlockedMinute)) {
    issues.push('Telegram digest times must satisfy ready < target < blocked');
  }
  const reportVersion = environment.TELEGRAM_REPORT_VERSION?.trim() || 'pilot-v1';
  if (!/^[a-z0-9_.-]{1,40}$/u.test(reportVersion)) issues.push('TELEGRAM_REPORT_VERSION has an invalid format');
  const pollTimeoutSeconds = integer(environment, 'TELEGRAM_POLL_TIMEOUT_SECONDS', 25, 1, 50, issues);
  const callbackTtlMs = integer(environment, 'TELEGRAM_CALLBACK_TTL_MS', 600_000, 60_000, 3_600_000, issues);
  const deliveryRetentionDays = integer(environment, 'TELEGRAM_STATE_RETENTION_DAYS', 45, 7, 180, issues);
  const matchingRateMinimum = ratio(environment, 'TELEGRAM_ALERT_MATCHING_RATE_MINIMUM', 0.02, issues);
  const matchingRateRecoveryMinimum = ratio(environment, 'TELEGRAM_ALERT_MATCHING_RATE_RECOVERY_MINIMUM', 0.05, issues);
  if (matchingRateRecoveryMinimum <= matchingRateMinimum) issues.push('Telegram matching recovery threshold must exceed its alert threshold');
  const diskWarningRatio = ratio(environment, 'TELEGRAM_ALERT_DISK_WARNING_RATIO', 0.15, issues);
  const diskCriticalRatio = ratio(environment, 'TELEGRAM_ALERT_DISK_CRITICAL_RATIO', 0.08, issues);
  if (diskCriticalRatio >= diskWarningRatio) issues.push('Critical disk free ratio must be lower than warning ratio');
  const thresholds = {
    durableIngestionStaleMs: integer(environment, 'TELEGRAM_ALERT_INGEST_STALE_MS', 120_000, 30_000, 3_600_000, issues),
    matchingRateMinimum,
    matchingRateRecoveryMinimum,
    matchingConsecutive: integer(environment, 'TELEGRAM_ALERT_MATCHING_CONSECUTIVE', 3, 1, 20, issues),
    malformedRateMaximum: ratio(environment, 'TELEGRAM_ALERT_MALFORMED_RATE_MAXIMUM', 0.25, issues),
    malformedConsecutive: integer(environment, 'TELEGRAM_ALERT_MALFORMED_CONSECUTIVE', 3, 1, 20, issues),
    spoolBacklogMs: integer(environment, 'TELEGRAM_ALERT_SPOOL_BACKLOG_MS', 300_000, 60_000, 3_600_000, issues),
    postgresConsecutive: integer(environment, 'TELEGRAM_ALERT_POSTGRES_CONSECUTIVE', 3, 1, 20, issues),
    cpuRatio: ratio(environment, 'TELEGRAM_ALERT_CPU_RATIO', 0.90, issues),
    cpuDurationMs: integer(environment, 'TELEGRAM_ALERT_CPU_DURATION_MS', 900_000, 60_000, 3_600_000, issues),
    memoryRatio: ratio(environment, 'TELEGRAM_ALERT_MEMORY_RATIO', 0.85, issues),
    memoryDurationMs: integer(environment, 'TELEGRAM_ALERT_MEMORY_DURATION_MS', 600_000, 60_000, 3_600_000, issues),
    diskWarningRatio,
    diskCriticalRatio,
    staticAgeDays: integer(environment, 'TELEGRAM_ALERT_STATIC_AGE_DAYS', 8, 1, 30, issues),
  };
  const procPath = environment.TELEGRAM_HOST_PROC_PATH?.trim() || undefined;
  const rootPath = environment.TELEGRAM_HOST_ROOT_PATH?.trim() || undefined;
  const hostEnabled = bool(environment, 'TELEGRAM_HOST_METRICS_ENABLED', false, issues);
  if (hostEnabled && (procPath === undefined || rootPath === undefined)) {
    issues.push('Host metrics mode requires TELEGRAM_HOST_PROC_PATH and TELEGRAM_HOST_ROOT_PATH read-only mounts');
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return {
    enabled,
    ...(botToken === undefined ? {} : { botToken }),
    ...(allowedUserId === undefined ? {} : { allowedUserId }),
    ...(privateChatId === undefined ? {} : { privateChatId }),
    apiBaseUrl,
    database: { ...app.database, applicationName: 'atodotren-telegram', statementTimeoutMs: Math.min(app.database.statementTimeoutMs, 5_000) },
    logLevel: app.logLevel,
    shutdownTimeoutMs: app.shutdownTimeoutMs,
    pollTimeoutSeconds,
    reportVersion,
    digestReadyMinute,
    digestTargetMinute,
    digestBlockedMinute,
    callbackTtlMs,
    deliveryRetentionDays,
    thresholds,
    hostMetrics: {
      enabled: hostEnabled,
      ...(procPath === undefined ? {} : { procPath }),
      ...(rootPath === undefined ? {} : { rootPath }),
    },
  };
}
