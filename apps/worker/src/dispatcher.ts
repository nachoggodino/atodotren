import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { ConfigError, loadConfig } from '@atodotren/config';
import {
  createDatabaseConnection,
  runDatabaseDoctor,
  type DatabaseConnection,
} from '@atodotren/db';
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
  ingest          Continuous GTFS-Realtime polling (not implemented in Milestone 0)
  import-static   Import and activate static GTFS (not implemented in Milestone 0)
  aggregate       Recompute dirty aggregate buckets (not implemented in Milestone 0)
  finalize        Finalize eligible service days (not implemented in Milestone 0)
  replay          Replay the local outage spool (not implemented in Milestone 0)
  doctor          Validate configuration, database, permissions, migrations, and clock
  report          Emit operational reports (not implemented in Milestone 0)

Global options:
  --help           Show this help
  --version        Show the worker version
`;

export const doctorUsage = `Usage:
  worker doctor

Validates configuration, database, exact role and migration state, permissions, and clock.
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
}

function isPlannedCommand(value: string): value is PlannedCommand {
  return (plannedCommands as readonly string[]).includes(value);
}

function parseIngestOptions(arguments_: readonly string[]): void {
  try {
    parseArgs({
      args: [...arguments_],
      allowPositionals: false,
      strict: true,
      options: {
        once: { type: 'boolean' },
        cycles: { type: 'string' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : 'Invalid ingest options');
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
  try {
    connection = await (dependencies.connect ?? createDatabaseConnection)(config.database, logger);
    await shutdown.register('database-pool', async () => connection?.close());
    if (shutdown.signal.aborted) {
      return 0;
    }
    const report = await (dependencies.doctor ?? runDatabaseDoctor)({
      connection,
      migrationsDirectory:
        environment.MIGRATIONS_DIR ?? resolve(dependencies.cwd ?? process.cwd(), 'migrations'),
      maxClockSkewMs: config.doctorMaxClockSkewMs,
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
  if (first === 'ingest') {
    parseIngestOptions(commandArguments);
  } else if (commandArguments.length > 0) {
    throw new UsageError(`Command ${first} does not accept options in Milestone 0`);
  }
  const logger = createLogger({ service: 'atodotren-worker', level: 'info', output: stdout });
  logger.error('command.not_implemented', `Command "${first}" is not implemented`, {
    command: first,
    milestone: 0,
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
