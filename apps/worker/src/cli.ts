#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { ConfigError, loadConfig } from '@atodotren/config';
import { createDatabaseConnection, runDatabaseDoctor } from '@atodotren/db';
import {
  createLogger,
  createShutdownManager,
} from '@atodotren/observability';

const version = '0.0.0';
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

const usage = `Atodotren worker ${version}

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

Future ingest options accepted by the command contract:
  --once           Run one bounded poll cycle
  --cycles <n>     Run a bounded number of poll cycles
`;

function isPlannedCommand(value: string): value is PlannedCommand {
  return (plannedCommands as readonly string[]).includes(value);
}

async function doctor(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger({ service: 'atodotren-worker', level: config.logLevel });
  const shutdown = createShutdownManager({
    logger,
    timeoutMs: config.shutdownTimeoutMs,
  });
  const connection = await createDatabaseConnection(config.database, logger);
  shutdown.register('database-pool', async () => connection.close());

  try {
    const report = await runDatabaseDoctor({
      connection,
      maxClockSkewMs: config.doctorMaxClockSkewMs,
    });
    for (const check of report.checks) {
      const fields = {
        check: check.name,
        status: check.status,
        ...check.details,
      };
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

export async function runCli(arguments_: readonly string[]): Promise<number> {
  const first = arguments_[0];
  if (first === undefined || first === '--help' || first === '-h') {
    process.stdout.write(usage);
    return first === undefined ? 2 : 0;
  }
  if (first === '--version' || first === '-v') {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (!isPlannedCommand(first)) {
    process.stderr.write(`Unknown worker command: ${first}\n\n${usage}`);
    return 2;
  }

  if (first !== 'doctor') {
    const logger = createLogger({ service: 'atodotren-worker', level: 'info' });
    if (first === 'ingest') {
      parseArgs({
        args: arguments_.slice(1),
        allowPositionals: false,
        strict: true,
        options: {
          once: { type: 'boolean' },
          cycles: { type: 'string' },
        },
      });
    } else if (arguments_.length > 1) {
      throw new Error(`Command ${first} does not accept options in Milestone 0`);
    }
    logger.error('command.not_implemented', `Command "${first}" is not implemented`, {
      command: first,
      milestone: 0,
    });
    return 2;
  }

  if (arguments_.length > 1) {
    throw new Error('Command doctor does not accept options in Milestone 0');
  }
  return doctor();
}

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const logger = createLogger({ service: 'atodotren-worker', level: 'error' });
    if (error instanceof ConfigError) {
      logger.error('config.invalid', 'Environment configuration is invalid', {
        issues: error.issues,
      });
    } else {
      logger.error('command.failed', 'Worker command failed', { error });
    }
    process.exitCode = 1;
  });
