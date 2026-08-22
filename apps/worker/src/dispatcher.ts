import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { ConfigError, loadConfig } from '@atodotren/config';
import {
  canonicalizeJourneys,
  closeJourneys,
  DEFAULT_ALGORITHM_VERSION,
  type CanonicalReport,
} from '@atodotren/canonical-journeys';
import {
  createDatabaseConnection,
  runDatabaseDoctor,
  type DatabaseConnection,
} from '@atodotren/db';
import {
  createSmtpTransport,
  createTelegramTransport,
  OutageSpool,
  runIngest,
  runReplay,
  testNotificationChannels,
} from '@atodotren/gtfs-realtime';
import {
  formatHumanReport,
  importStaticFeed,
  RENFE_STATIC_URL,
  renfeMadridMapping,
} from '@atodotren/gtfs-static';
import { createLogger, createShutdownManager } from '@atodotren/observability';

type ExitCode = 0 | 1 | 2;
type Output = Pick<NodeJS.WritableStream, 'write'>;
const packageVersion = (JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as { version: string }).version;
const plannedCommands = [
  'ingest',
  'import-static',
  'canonicalize',
  'close-journeys',
  'repair-journeys',
  'aggregate',
  'finalize',
  'replay',
  'doctor',
  'test-notifications',
  'report',
] as const;
type PlannedCommand = (typeof plannedCommands)[number];

export const rootUsage = `Atodotren worker ${packageVersion}

Usage:
  worker <command> [options]

Commands:
  ingest          Poll and persist Madrid GTFS-Realtime evidence
  import-static   Import and transactionally activate Madrid static GTFS
  canonicalize   Build or refresh bounded canonical journeys from retained evidence
  close-journeys Close journeys past scheduled end plus the configured grace
  repair-journeys  Explicitly rebuild closed journeys with a new version
  aggregate       Recompute dirty aggregate buckets (planned for a later milestone)
  finalize        Finalize eligible service days (planned for a later milestone)
  replay          Replay the local outage spool and exit
  doctor          Validate database contracts and the active Madrid static feed
  test-notifications  Explicitly test configured operational delivery channels
  report          Emit operational reports (planned for a later milestone)

Global options:
  --help           Show this help
  --version        Show the worker version
`;

export const doctorUsage = `Usage:
  worker doctor

Validates configuration, database, exact role and migration state, permissions, and clock.
`;

export const ingestUsage = `Usage:
  worker ingest [--once | --cycles <positive-integer>] [--canonical-maintenance]

Polls enabled GTFS-Realtime feeds without overlapping cycles. Continuous polling
is the default; --once is equivalent to --cycles 1. --canonical-maintenance runs
bounded canonicalization and closure after every polling cycle.
`;

export const replayUsage = `Usage:
  worker replay

Replays normalized SQLite spool entries to PostgreSQL in source order and exits.
`;

export const testNotificationsUsage = `Usage:
  worker test-notifications --confirm-send

Sends one clearly labelled test through each configured Telegram, SMTP, and
heartbeat channel. ATODOTREN_NOTIFICATION_TEST=1 is an alternative explicit opt-in.
No operational incident is created or changed.
`;

export const importStaticUsage = `Usage:
  worker import-static [--url <https-url> | --file <local.zip>] [--force-recheck] [--json]

Defaults to the configured RENFE Cercanías static URL. A local ZIP provides a
deterministic recovery and fixture path. --force-recheck omits HTTP validators;
checksum idempotency still applies. Exit 0 means imported or unchanged, 1 means
configuration/download/validation/database failure, and 2 means invalid usage.
`;

export const canonicalUsage = `Usage:
  worker canonicalize [--service-date <YYYY-MM-DD>] [--limit <1-10000>] [--rebuild] [--algorithm-version <version>]
  worker close-journeys [--service-date <YYYY-MM-DD>] [--limit <1-10000>] [--grace-seconds <0-86400>] [--now <ISO-instant>]
  worker repair-journeys --service-date <YYYY-MM-DD> --algorithm-version <new-version> --repair-version <positive-integer> --reason <text> [--limit <1-10000>]

All commands are bounded and emit one JSON report. Rebuild replays a specified
date for open/disposable data; closed data requires the explicit repair command.
`;

export class UsageError extends Error {
  public readonly usage: string;

  public constructor(message: string, usage = rootUsage) {
    super(message);
    this.name = 'UsageError';
    this.usage = usage;
  }
}

export interface DispatcherDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: Output;
  readonly stderr?: Output;
  readonly cwd?: string;
  readonly connect?: typeof createDatabaseConnection;
  readonly doctor?: typeof runDatabaseDoctor;
  readonly importStatic?: typeof importStaticFeed;
  readonly ingest?: typeof runIngest;
  readonly replay?: typeof runReplay;
  readonly notificationTest?: typeof testNotificationChannels;
  readonly canonicalize?: typeof canonicalizeJourneys;
  readonly closeJourneys?: typeof closeJourneys;
}

interface CanonicalCliOptions {
  readonly serviceDate?: string;
  readonly limit?: number;
  readonly algorithmVersion: string;
  readonly rebuild: boolean;
  readonly repairVersion?: number;
  readonly repairReason?: string;
  readonly graceSeconds?: number;
  readonly now?: Date;
  readonly help: boolean;
}

function positiveInteger(value: string | undefined, name: string, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new UsageError(`${name} must be an integer from 1 through ${maximum}`, canonicalUsage);
  }
  return parsed;
}

function parseCanonicalOptions(arguments_: readonly string[], command: 'canonicalize' | 'close-journeys' | 'repair-journeys'): CanonicalCliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...arguments_], allowPositionals: false, strict: true,
      options: {
        'service-date': { type: 'string' }, limit: { type: 'string' }, rebuild: { type: 'boolean' },
        'algorithm-version': { type: 'string' }, 'repair-version': { type: 'string' },
        reason: { type: 'string' }, 'grace-seconds': { type: 'string' }, now: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : 'Invalid canonical options', canonicalUsage);
  }
  if (parsed.values.help === true) return { algorithmVersion: DEFAULT_ALGORITHM_VERSION, rebuild: false, help: true };
  const serviceDate = parsed.values['service-date'];
  if (serviceDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(serviceDate)) {
    throw new UsageError('--service-date must use YYYY-MM-DD', canonicalUsage);
  }
  const limit = positiveInteger(parsed.values.limit, '--limit', 10_000);
  const algorithmVersion = parsed.values['algorithm-version'] ?? DEFAULT_ALGORITHM_VERSION;
  if (!/^[a-z0-9_.-]{1,40}$/u.test(algorithmVersion)) throw new UsageError('Invalid --algorithm-version', canonicalUsage);
  if (command === 'canonicalize') {
    if (parsed.values.rebuild === true && serviceDate === undefined) throw new UsageError('--rebuild requires --service-date', canonicalUsage);
    if (parsed.values['repair-version'] !== undefined || parsed.values.reason !== undefined || parsed.values['grace-seconds'] !== undefined || parsed.values.now !== undefined) {
      throw new UsageError('canonicalize received options for another command', canonicalUsage);
    }
  }
  let repairVersion: number | undefined;
  if (command === 'repair-journeys') {
    repairVersion = positiveInteger(parsed.values['repair-version'], '--repair-version', 2_147_483_647);
    if (serviceDate === undefined || repairVersion === undefined || parsed.values.reason?.trim() === '' || parsed.values.reason === undefined || parsed.values['algorithm-version'] === undefined) {
      throw new UsageError('repair-journeys requires service date, new algorithm version, repair version, and reason', canonicalUsage);
    }
    if (parsed.values.rebuild === true || parsed.values['grace-seconds'] !== undefined || parsed.values.now !== undefined) throw new UsageError('repair-journeys received incompatible options', canonicalUsage);
  }
  let graceSeconds: number | undefined;
  let now: Date | undefined;
  if (command === 'close-journeys') {
    const rawGrace = parsed.values['grace-seconds'];
    if (rawGrace !== undefined) {
      graceSeconds = Number(rawGrace);
      if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 0 || graceSeconds > 86_400) throw new UsageError('--grace-seconds must be from 0 through 86400', canonicalUsage);
    }
    if (parsed.values.now !== undefined) {
      now = new Date(parsed.values.now);
      if (Number.isNaN(now.getTime())) throw new UsageError('--now must be an ISO instant', canonicalUsage);
    }
    if (parsed.values.rebuild === true || parsed.values['repair-version'] !== undefined || parsed.values.reason !== undefined) throw new UsageError('close-journeys received incompatible options', canonicalUsage);
  }
  return {
    ...(serviceDate === undefined ? {} : { serviceDate }), ...(limit === undefined ? {} : { limit }),
    algorithmVersion, rebuild: parsed.values.rebuild ?? false,
    ...(repairVersion === undefined ? {} : { repairVersion }),
    ...(parsed.values.reason === undefined ? {} : { repairReason: parsed.values.reason }),
    ...(graceSeconds === undefined ? {} : { graceSeconds }), ...(now === undefined ? {} : { now }), help: false,
  };
}

export async function runCanonicalCommand(
  command: 'canonicalize' | 'close-journeys' | 'repair-journeys',
  options: CanonicalCliOptions,
  dependencies: DispatcherDependencies = {},
): Promise<0 | 1> {
  const config = loadConfig(dependencies.environment ?? process.env);
  const connection = await (dependencies.connect ?? createDatabaseConnection)(config.database);
  try {
    let report: CanonicalReport;
    if (command === 'close-journeys') {
      report = await (dependencies.closeJourneys ?? closeJourneys)({
        pool: connection.pool, algorithmVersion: options.algorithmVersion,
        ...(options.serviceDate === undefined ? {} : { serviceDate: options.serviceDate }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.graceSeconds === undefined ? {} : { graceSeconds: options.graceSeconds }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    } else {
      report = await (dependencies.canonicalize ?? canonicalizeJourneys)({
        pool: connection.pool, algorithmVersion: options.algorithmVersion,
        rebuild: options.rebuild,
        ...(options.serviceDate === undefined ? {} : { serviceDate: options.serviceDate }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.repairVersion === undefined ? {} : { repairVersion: options.repairVersion }),
        ...(options.repairReason === undefined ? {} : { repairReason: options.repairReason }),
      });
    }
    (dependencies.stdout ?? process.stdout).write(`${JSON.stringify(report)}\n`);
    return Object.keys(report.errors).length === 0 ? 0 : 1;
  } finally {
    await connection.close();
  }
}

interface ImportStaticCliOptions {
  readonly source: { readonly kind: 'http'; readonly url: string } | { readonly kind: 'file'; readonly path: string };
  readonly forceRecheck: boolean;
  readonly json: boolean;
}

function parseImportStaticOptions(arguments_: readonly string[]): ImportStaticCliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...arguments_],
      allowPositionals: false,
      strict: true,
      options: {
        url: { type: 'string' },
        file: { type: 'string' },
        'force-recheck': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : 'Invalid import-static options', importStaticUsage);
  }
  if (parsed.values.help === true) {
    if (arguments_.length !== 1) throw new UsageError('import-static help does not accept other options', importStaticUsage);
    return { source: { kind: 'http', url: RENFE_STATIC_URL }, forceRecheck: false, json: false };
  }
  if (parsed.values.url !== undefined && parsed.values.file !== undefined) {
    throw new UsageError('--url and --file are mutually exclusive', importStaticUsage);
  }
  if (parsed.values.url === '' || parsed.values.file === '') {
    throw new UsageError('--url and --file require a non-empty value', importStaticUsage);
  }
  return {
    source: parsed.values.file === undefined
      ? { kind: 'http', url: parsed.values.url ?? RENFE_STATIC_URL }
      : { kind: 'file', path: parsed.values.file },
    forceRecheck: parsed.values['force-recheck'] ?? false,
    json: parsed.values.json ?? false,
  };
}

export async function runImportStaticCommand(
  cliOptions: ImportStaticCliOptions,
  dependencies: DispatcherDependencies = {},
): Promise<0 | 1> {
  const environment = dependencies.environment ?? process.env;
  const config = loadConfig(environment);
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const logger = createLogger({ service: 'atodotren-worker', level: config.logLevel, output: stderr });
  const shutdown = createShutdownManager({ logger, timeoutMs: config.shutdownTimeoutMs });
  let connection: DatabaseConnection | undefined;
  try {
    connection = await (dependencies.connect ?? createDatabaseConnection)(config.database, logger);
    await shutdown.register('database-pool', async () => connection?.close());
    const requiredLines = (environment.GTFS_STATIC_REQUIRED_LINE_CODES ?? '')
      .split(',').map((value) => value.trim()).filter((value) => value !== '');
    const requiredStations = (environment.GTFS_STATIC_REQUIRED_STATION_IDS ?? '')
      .split(',').map((value) => value.trim()).filter((value) => value !== '');
    const report = await (dependencies.importStatic ?? importStaticFeed)({
      pool: connection.pool,
      source: cliOptions.source,
      forceRecheck: cliOptions.forceRecheck,
      signal: shutdown.signal,
      ...(environment.GTFS_STATIC_TEMP_DIR === undefined ? {} : { temporaryDirectory: environment.GTFS_STATIC_TEMP_DIR }),
      mapping: {
        ...renfeMadridMapping,
        canaries: {
          ...renfeMadridMapping.canaries,
          requiredLineCodes: requiredLines,
          requiredStationPublicIds: requiredStations,
        },
      },
    });
    stdout.write(cliOptions.json ? `${JSON.stringify(report)}\n` : formatHumanReport(report));
    return report.ok ? 0 : 1;
  } finally {
    await shutdown.shutdown('command-complete');
    shutdown.dispose();
  }
}

function isPlannedCommand(value: string): value is PlannedCommand {
  return (plannedCommands as readonly string[]).includes(value);
}

function parseIngestOptions(arguments_: readonly string[]): {
  readonly cycles?: number; readonly canonicalMaintenance: boolean; readonly help: boolean;
} {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...arguments_],
      allowPositionals: false,
      strict: true,
      options: {
        once: { type: 'boolean' },
        cycles: { type: 'string' },
        'canonical-maintenance': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : 'Invalid ingest options', ingestUsage);
  }
  if (parsed.values.help === true) {
    if (arguments_.length !== 1) throw new UsageError('ingest help does not accept other options', ingestUsage);
    return { canonicalMaintenance: false, help: true };
  }
  if (parsed.values.once === true && parsed.values.cycles !== undefined) {
    throw new UsageError('--once and --cycles are mutually exclusive', ingestUsage);
  }
  const canonicalMaintenance = parsed.values['canonical-maintenance'] ?? false;
  if (parsed.values.once === true) return { cycles: 1, canonicalMaintenance, help: false };
  if (parsed.values.cycles === undefined) return { canonicalMaintenance, help: false };
  const cycles = Number(parsed.values.cycles);
  if (!Number.isSafeInteger(cycles) || cycles <= 0) {
    throw new UsageError('--cycles must be a positive integer', ingestUsage);
  }
  return { cycles, canonicalMaintenance, help: false };
}

export async function runIngestCommand(
  cliOptions: { readonly cycles?: number; readonly canonicalMaintenance?: boolean },
  dependencies: DispatcherDependencies = {},
): Promise<0 | 1> {
  const environment = dependencies.environment ?? process.env;
  const config = loadConfig(environment);
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const logger = createLogger({ service: 'atodotren-worker', level: config.logLevel, output: stderr });
  const shutdown = createShutdownManager({ logger, timeoutMs: config.shutdownTimeoutMs });
  let connection: DatabaseConnection | undefined;
  let spool: OutageSpool | undefined;
  try {
    connection = await (dependencies.connect ?? createDatabaseConnection)(config.database, logger);
    const canonicalPool = connection.pool;
    await shutdown.register('database-pool', async () => connection?.close());
    spool = new OutageSpool(config.spool.path, config.spool.maxBytes, config.spool.maxBacklogMs);
    await shutdown.register('sqlite-spool', () => spool?.close());
    const transports = [
      ...(config.operations.telegram === undefined ? [] : [createTelegramTransport(config.operations.telegram)]),
      ...(config.operations.smtp === undefined ? [] : [createSmtpTransport(config.operations.smtp)]),
    ];
    const report = await (dependencies.ingest ?? runIngest)({
      pool: connection.pool,
      spool,
      config: {
        endpoints: [
          { kind: 'trip_updates', ...config.realtime.tripUpdates },
          { kind: 'vehicle_positions', ...config.realtime.vehiclePositions },
          { kind: 'service_alerts', ...config.realtime.serviceAlerts },
        ],
        requestTimeoutMs: config.realtime.requestTimeoutMs,
        maxResponseBytes: config.realtime.maxResponseBytes,
        cycleIntervalMs: config.realtime.cycleIntervalMs,
        alertIntervalMs: config.realtime.alertIntervalMs,
        ...(config.operations.heartbeatUrl === undefined ? {} : { heartbeatUrl: config.operations.heartbeatUrl }),
        failureThreshold: config.operations.failureThreshold,
        matchingRateMinimum: config.operations.matchingRateMinimum,
        matchingRateRecoveryMinimum: config.operations.matchingRateRecoveryMinimum,
        matchingRecoveryThreshold: config.operations.matchingRecoveryThreshold,
        malformedRateMaximum: config.operations.malformedRateMaximum,
        spoolWarningRatio: config.operations.spoolWarningRatio,
        staleAfterMs: config.operations.staleAfterMs,
      },
      ...(cliOptions.cycles === undefined ? {} : { cycles: cliOptions.cycles }),
      signal: shutdown.signal,
      transports,
      ...(cliOptions.canonicalMaintenance === true ? {
        afterCycle: async () => {
          const canonical = await (dependencies.canonicalize ?? canonicalizeJourneys)({ pool: canonicalPool, limit: 100 });
          const closed = await (dependencies.closeJourneys ?? closeJourneys)({ pool: canonicalPool, limit: 100 });
          if (Object.keys(canonical.errors).length > 0 || Object.keys(closed.errors).length > 0) {
            throw new Error('Canonical maintenance reported bounded errors');
          }
          logger.info('canonical.maintenance', 'Canonical maintenance completed', {
            journeysCreated: canonical.journeysCreated,
            journeysUpdated: canonical.journeysUpdated,
            journeysClosed: canonical.journeysClosed + closed.journeysClosed,
            journeyStopsMaterialized: canonical.journeyStopsMaterialized,
          });
        },
      } : {}),
      onEvent: (event, fields) => {
        if (event.startsWith('notification.')) logger.warn(event, 'Notification operation failed', fields);
        else if (event === 'canonical.maintenance_failed') logger.error(event, 'Canonical maintenance failed', fields);
        else logger.info(event, 'Realtime feed poll completed', fields);
      },
    });
    stdout.write(`${JSON.stringify({ command: 'ingest', ...report, spool: spool.stats() })}\n`);
    return report.cyclesAttempted > 0 && report.successfulCycles === report.cyclesAttempted ? 0 : 1;
  } finally {
    await shutdown.shutdown('command-complete');
    shutdown.dispose();
  }
}

export async function runNotificationTestCommand(
  dependencies: DispatcherDependencies = {},
): Promise<0 | 1> {
  const environment = dependencies.environment ?? process.env;
  const config = loadConfig(environment);
  const stdout = dependencies.stdout ?? process.stdout;
  const transports = [
    ...(config.operations.telegram === undefined ? [] : [createTelegramTransport(config.operations.telegram)]),
    ...(config.operations.smtp === undefined ? [] : [createSmtpTransport(config.operations.smtp)]),
  ];
  const channels = await (dependencies.notificationTest ?? testNotificationChannels)({
    transports,
    ...(config.operations.heartbeatUrl === undefined ? {} : { heartbeatUrl: config.operations.heartbeatUrl }),
  });
  const report = {
    command: 'test-notifications',
    configured: channels.filter((channel) => channel.configured).length,
    delivered: channels.filter((channel) => channel.status === 'delivered').length,
    failed: channels.filter((channel) => channel.status === 'failed').length,
    skipped: channels.filter((channel) => channel.status === 'skipped').length,
    channels,
  };
  stdout.write(`${JSON.stringify(report)}\n`);
  return report.failed === 0 ? 0 : 1;
}

export async function runReplayCommand(dependencies: DispatcherDependencies = {}): Promise<0 | 1> {
  const environment = dependencies.environment ?? process.env;
  const config = loadConfig(environment);
  const stdout = dependencies.stdout ?? process.stdout;
  const logger = createLogger({ service: 'atodotren-worker', level: config.logLevel, output: dependencies.stderr ?? process.stderr });
  const shutdown = createShutdownManager({ logger, timeoutMs: config.shutdownTimeoutMs });
  let connection: DatabaseConnection | undefined;
  let spool: OutageSpool | undefined;
  try {
    connection = await (dependencies.connect ?? createDatabaseConnection)(config.database, logger);
    await shutdown.register('database-pool', async () => connection?.close());
    spool = new OutageSpool(config.spool.path, config.spool.maxBytes, config.spool.maxBacklogMs);
    await shutdown.register('sqlite-spool', () => spool?.close());
    const result = await (dependencies.replay ?? runReplay)(connection.pool, spool);
    stdout.write(`${JSON.stringify({ command: 'replay', ...result, spool: spool.stats() })}\n`);
    return result.pending === 0 ? 0 : 1;
  } finally {
    await shutdown.shutdown('command-complete');
    shutdown.dispose();
  }
}

export async function runDoctorCommand(
  dependencies: DispatcherDependencies = {},
): Promise<0> {
  const environment = dependencies.environment ?? process.env;
  const config = loadConfig(environment);
  const logger = createLogger({
    service: 'atodotren-worker',
    level: config.logLevel,
    ...(dependencies.stdout === undefined ? {} : { output: dependencies.stdout }),
  });
  const shutdown = createShutdownManager({ logger, timeoutMs: config.shutdownTimeoutMs });
  let connection: DatabaseConnection | undefined;
  let spool: OutageSpool | undefined;
  try {
    connection = await (dependencies.connect ?? createDatabaseConnection)(config.database, logger);
    await shutdown.register('database-pool', async () => connection?.close());
    spool = new OutageSpool(config.spool.path, config.spool.maxBytes, config.spool.maxBacklogMs);
    await shutdown.register('sqlite-spool', () => spool?.close());
    if (shutdown.signal.aborted) {
      return 0;
    }
    const report = await (dependencies.doctor ?? runDatabaseDoctor)({
      connection,
      migrationsDirectory:
        environment.MIGRATIONS_DIR ?? resolve(dependencies.cwd ?? process.cwd(), 'migrations'),
      maxClockSkewMs: config.doctorMaxClockSkewMs,
      realtime: {
        endpoints: [
          { kind: 'trip_updates', ...config.realtime.tripUpdates },
          { kind: 'vehicle_positions', ...config.realtime.vehiclePositions },
          { kind: 'service_alerts', ...config.realtime.serviceAlerts },
        ],
        pollFreshnessMs: config.operations.staleAfterMs,
        spool: {
          path: config.spool.path,
          writable: true,
          sizeBytes: spool.sizeBytes(),
          maxBytes: config.spool.maxBytes,
          pendingCount: spool.stats().pendingCount,
          droppedCount: spool.stats().droppedCount,
        },
        heartbeatConfigured: config.operations.heartbeatUrl !== undefined,
      },
    });
    for (const check of report.checks) {
      const fields = { check: check.name, status: check.status, ...check.details };
      if (check.status === 'pass') {
        logger.info('doctor.check', `Doctor check ${check.status}`, fields);
      } else {
        logger.warn('doctor.check', `Doctor check ${check.status}`, fields);
      }
    }
    logger.info('doctor.complete', 'Worker doctor completed successfully', {
      ok: report.ok,
      scope: report.scope,
      passed: report.checks.filter((check) => check.status === 'pass').length,
      deferred: report.checks.filter((check) => check.status === 'deferred').length,
    });
    return 0;
  } finally {
    await shutdown.shutdown('command-complete');
    shutdown.dispose();
  }
}

export async function dispatchCli(
  arguments_: readonly string[],
  dependencies: DispatcherDependencies = {},
): Promise<0 | 1> {
  const stdout = dependencies.stdout ?? process.stdout;
  const first = arguments_[0];
  if (first === undefined) {
    throw new UsageError('A worker command is required');
  }
  if (first === '--help' || first === '-h') {
    if (arguments_.length !== 1) throw new UsageError('Root help does not accept arguments');
    stdout.write(rootUsage);
    return 0;
  }
  if (first === '--version' || first === '-v') {
    if (arguments_.length !== 1) throw new UsageError('Root version does not accept arguments');
    stdout.write(`${packageVersion}\n`);
    return 0;
  }
  if (first.startsWith('-')) {
    throw new UsageError(`Unknown worker option: ${first}`);
  }
  if (!isPlannedCommand(first)) {
    throw new UsageError(`Unknown worker command: ${first}`);
  }
  const commandArguments = arguments_.slice(1);
  if (first === 'doctor') {
    if (commandArguments.length === 1 && ['--help', '-h'].includes(commandArguments[0] ?? '')) {
      stdout.write(doctorUsage);
      return 0;
    }
    if (commandArguments.length > 0) {
      throw new UsageError('Command doctor does not accept options', doctorUsage);
    }
    return runDoctorCommand(dependencies);
  }
  if (first === 'import-static') {
    if (commandArguments.length === 1 && ['--help', '-h'].includes(commandArguments[0] ?? '')) {
      stdout.write(importStaticUsage);
      return 0;
    }
    return runImportStaticCommand(parseImportStaticOptions(commandArguments), dependencies);
  }
  if (first === 'ingest') {
    const options = parseIngestOptions(commandArguments);
    if (options.help) {
      stdout.write(ingestUsage);
      return 0;
    }
    return runIngestCommand(options, dependencies);
  }
  if (first === 'replay') {
    if (commandArguments.length === 1 && ['--help', '-h'].includes(commandArguments[0] ?? '')) {
      stdout.write(replayUsage);
      return 0;
    }
    if (commandArguments.length > 0) throw new UsageError('Command replay does not accept options', replayUsage);
    return runReplayCommand(dependencies);
  }
  if (first === 'canonicalize' || first === 'close-journeys' || first === 'repair-journeys') {
    const options = parseCanonicalOptions(commandArguments, first);
    if (options.help) {
      stdout.write(canonicalUsage);
      return 0;
    }
    return runCanonicalCommand(first, options, dependencies);
  }
  if (first === 'test-notifications') {
    if (commandArguments.length === 1 && ['--help', '-h'].includes(commandArguments[0] ?? '')) {
      stdout.write(testNotificationsUsage);
      return 0;
    }
    const confirmed = commandArguments.length === 1 && commandArguments[0] === '--confirm-send';
    if ((!confirmed && commandArguments.length > 0) ||
        (!confirmed && (dependencies.environment ?? process.env).ATODOTREN_NOTIFICATION_TEST !== '1')) {
      throw new UsageError('Notification delivery test requires explicit opt-in', testNotificationsUsage);
    }
    return runNotificationTestCommand(dependencies);
  } else if (commandArguments.length > 0) {
    throw new UsageError(`Command ${first} does not accept options in Milestone 1`);
  }
  const logger = createLogger({ service: 'atodotren-worker', level: 'info', output: stdout });
  logger.error('command.not_implemented', `Command "${first}" is not implemented`, {
    command: first,
    milestone: 1,
  });
  return 1;
}

export async function executeCli(
  arguments_: readonly string[],
  dependencies: DispatcherDependencies = {},
): Promise<ExitCode> {
  const stderr = dependencies.stderr ?? process.stderr;
  const stdout = dependencies.stdout ?? process.stdout;
  try {
    return await dispatchCli(arguments_, dependencies);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${error.message}\n\n${error.usage}`);
      return 2;
    }
    const logger = createLogger({ service: 'atodotren-worker', level: 'error', output: stdout });
    if (error instanceof ConfigError) {
      logger.error('config.invalid', 'Environment configuration is invalid', {
        issues: error.issues,
      });
    } else {
      logger.error('command.failed', 'Worker command failed', { error });
    }
    return 1;
  }
}
