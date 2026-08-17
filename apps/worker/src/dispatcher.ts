import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { ConfigError, loadConfig } from '@atodotren/config';
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
  'aggregate',
  'finalize',
  'replay',
  'doctor',
  'report',
] as const;
type PlannedCommand = (typeof plannedCommands)[number];

export const rootUsage = `Atodotren worker ${packageVersion}

Usage:
  worker <command> [options]

Commands:
  ingest          Poll and persist Madrid GTFS-Realtime evidence
  import-static   Import and transactionally activate Madrid static GTFS
  aggregate       Recompute dirty aggregate buckets (planned for a later milestone)
  finalize        Finalize eligible service days (planned for a later milestone)
  replay          Replay the local outage spool and exit
  doctor          Validate database contracts and the active Madrid static feed
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
  worker ingest [--once | --cycles <positive-integer>]

Polls enabled GTFS-Realtime feeds without overlapping cycles. Continuous polling
is the default; --once is equivalent to --cycles 1.
`;

export const replayUsage = `Usage:
  worker replay

Replays normalized SQLite spool entries to PostgreSQL in source order and exits.
`;

export const importStaticUsage = `Usage:
  worker import-static [--url <https-url> | --file <local.zip>] [--force-recheck] [--json]

Defaults to the configured RENFE Cercanías static URL. A local ZIP provides a
deterministic recovery and fixture path. --force-recheck omits HTTP validators;
checksum idempotency still applies. Exit 0 means imported or unchanged, 1 means
configuration/download/validation/database failure, and 2 means invalid usage.
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

function parseIngestOptions(arguments_: readonly string[]): { readonly cycles?: number; readonly help: boolean } {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...arguments_],
      allowPositionals: false,
      strict: true,
      options: {
        once: { type: 'boolean' },
        cycles: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : 'Invalid ingest options', ingestUsage);
  }
  if (parsed.values.help === true) {
    if (arguments_.length !== 1) throw new UsageError('ingest help does not accept other options', ingestUsage);
    return { help: true };
  }
  if (parsed.values.once === true && parsed.values.cycles !== undefined) {
    throw new UsageError('--once and --cycles are mutually exclusive', ingestUsage);
  }
  if (parsed.values.once === true) return { cycles: 1, help: false };
  if (parsed.values.cycles === undefined) return { help: false };
  const cycles = Number(parsed.values.cycles);
  if (!Number.isSafeInteger(cycles) || cycles <= 0) {
    throw new UsageError('--cycles must be a positive integer', ingestUsage);
  }
  return { cycles, help: false };
}

export async function runIngestCommand(
  cliOptions: { readonly cycles?: number },
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
        malformedRateMaximum: config.operations.malformedRateMaximum,
        spoolWarningRatio: config.operations.spoolWarningRatio,
        staleAfterMs: config.operations.staleAfterMs,
      },
      ...(cliOptions.cycles === undefined ? {} : { cycles: cliOptions.cycles }),
      signal: shutdown.signal,
      transports,
      onEvent: (event, fields) => logger.info(event, 'Realtime feed poll completed', fields),
    });
    stdout.write(`${JSON.stringify({ command: 'ingest', ...report, spool: spool.stats() })}\n`);
    return report.cyclesAttempted > 0 && report.successfulCycles === report.cyclesAttempted ? 0 : 1;
  } finally {
    await shutdown.shutdown('command-complete');
    shutdown.dispose();
  }
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
