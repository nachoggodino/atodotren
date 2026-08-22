import { parseArgs } from 'node:util';

import { ConfigError, loadConfig } from '@atodotren/config';
import { createDatabaseConnection } from '@atodotren/db';
import { runIngest } from '@atodotren/gtfs-realtime';
import { createLogger } from '@atodotren/observability';

import {
  aggregateDirty,
  DEFAULT_AGGREGATE_ALGORITHM_VERSION,
  finalizeAnalytics,
  RETENTION_CONFIRMATION,
  type RetentionMode,
} from './analytics.js';
import {
  executeCli,
  rootUsage,
  type DispatcherDependencies,
} from './dispatcher.js';

type ExitCode = 0 | 1 | 2;
type Output = Pick<NodeJS.WritableStream, 'write'>;

export const aggregateUsage = `Usage:
  worker aggregate [--service-date <YYYY-MM-DD>] [--limit <1-500>] [--algorithm-version <version>]

Recomputes daily aggregate scopes from canonical source rows using deterministic
replacement semantics. Without a date, the oldest dirty scopes are processed first.
`;

export const finalizeUsage = `Usage:
  worker finalize [--service-date <YYYY-MM-DD>] [--month <YYYY-MM-01>] [--limit <1-200>]
    [--algorithm-version <version>] [--now <ISO-instant>] [--grace-seconds <0-86400>]
    [--month-grace-hours <0-168>] [--acknowledge-incomplete <reason>]
    [--retention | --authorize-retention |
     --apply-retention --confirm-retention DROP-VERIFIED-PARTITIONS]
    [--live-state-grace-seconds <0-86400>]

Finalization verifies canonical closure, aggregate denominators, algorithm versions
and checksums. --retention is dry-run only. --authorize-retention may write a
retention-ledger authorization but never deletes. --apply-retention only drops
already-authorized known partitions and requires the literal confirmation above.
Acknowledging an incomplete outage day requires an explicit --service-date.
`;

export const milestone4RootUsage = rootUsage
  .replace('Recompute dirty aggregate buckets (planned for a later milestone)', 'Recompute bounded dirty daily aggregate scopes')
  .replace('Finalize eligible service days (planned for a later milestone)', 'Verify service days, seal months, and gate retention');

export interface Milestone4Dependencies extends DispatcherDependencies {
  readonly aggregate?: typeof aggregateDirty;
  readonly finalize?: typeof finalizeAnalytics;
  readonly realtimeIngest?: typeof runIngest;
  readonly now?: () => Date;
}

interface AggregateCliOptions {
  readonly serviceDate?: string;
  readonly limit?: number;
  readonly algorithmVersion: string;
  readonly help: boolean;
}

interface FinalizeCliOptions {
  readonly serviceDate?: string;
  readonly month?: string;
  readonly limit?: number;
  readonly algorithmVersion: string;
  readonly now?: Date;
  readonly graceSeconds?: number;
  readonly monthGraceHours?: number;
  readonly acknowledgeIncomplete?: string;
  readonly retentionMode: RetentionMode;
  readonly liveStateGraceSeconds?: number;
  readonly help: boolean;
}

class Milestone4UsageError extends Error {
  public constructor(message: string, public readonly usage: string) {
    super(message);
    this.name = 'Milestone4UsageError';
  }
}

function boundedInteger(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
  usage: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Milestone4UsageError(`${name} must be an integer from ${minimum} through ${maximum}`, usage);
  }
  return parsed;
}

function algorithmVersion(value: string | undefined, usage: string): string {
  const version = value ?? DEFAULT_AGGREGATE_ALGORITHM_VERSION;
  if (!/^[a-z0-9_.-]{1,40}$/u.test(version)) {
    throw new Milestone4UsageError('Invalid --algorithm-version', usage);
  }
  return version;
}

function serviceDate(value: string | undefined, usage: string): string | undefined {
  if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Milestone4UsageError('--service-date must use YYYY-MM-DD', usage);
  }
  return value;
}

function parseAggregate(arguments_: readonly string[]): AggregateCliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...arguments_], allowPositionals: false, strict: true,
      options: {
        'service-date': { type: 'string' }, limit: { type: 'string' },
        'algorithm-version': { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new Milestone4UsageError(error instanceof Error ? error.message : 'Invalid aggregate options', aggregateUsage);
  }
  if (parsed.values.help === true) {
    return { algorithmVersion: DEFAULT_AGGREGATE_ALGORITHM_VERSION, help: true };
  }
  const date = serviceDate(parsed.values['service-date'], aggregateUsage);
  const limit = boundedInteger(parsed.values.limit, '--limit', 1, 500, aggregateUsage);
  return {
    ...(date === undefined ? {} : { serviceDate: date }),
    ...(limit === undefined ? {} : { limit }),
    algorithmVersion: algorithmVersion(parsed.values['algorithm-version'], aggregateUsage),
    help: false,
  };
}

function parseFinalize(arguments_: readonly string[]): FinalizeCliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...arguments_], allowPositionals: false, strict: true,
      options: {
        'service-date': { type: 'string' }, month: { type: 'string' }, limit: { type: 'string' },
        'algorithm-version': { type: 'string' }, now: { type: 'string' },
        'grace-seconds': { type: 'string' }, 'month-grace-hours': { type: 'string' },
        'acknowledge-incomplete': { type: 'string' },
        retention: { type: 'boolean' }, 'authorize-retention': { type: 'boolean' },
        'apply-retention': { type: 'boolean' }, 'confirm-retention': { type: 'string' },
        'live-state-grace-seconds': { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new Milestone4UsageError(error instanceof Error ? error.message : 'Invalid finalize options', finalizeUsage);
  }
  if (parsed.values.help === true) {
    return { algorithmVersion: DEFAULT_AGGREGATE_ALGORITHM_VERSION, retentionMode: 'none', help: true };
  }
  const date = serviceDate(parsed.values['service-date'], finalizeUsage);
  const month = parsed.values.month;
  if (month !== undefined && !/^\d{4}-\d{2}-01$/u.test(month)) {
    throw new Milestone4UsageError('--month must use YYYY-MM-01', finalizeUsage);
  }
  const retentionFlags = [parsed.values.retention, parsed.values['authorize-retention'], parsed.values['apply-retention']]
    .filter((value) => value === true).length;
  if (retentionFlags > 1) {
    throw new Milestone4UsageError('Retention modes are mutually exclusive', finalizeUsage);
  }
  let retentionMode: RetentionMode = 'none';
  if (parsed.values.retention === true) retentionMode = 'plan';
  if (parsed.values['authorize-retention'] === true) retentionMode = 'authorize';
  if (parsed.values['apply-retention'] === true) retentionMode = 'apply';
  if (retentionMode === 'apply' && parsed.values['confirm-retention'] !== RETENTION_CONFIRMATION) {
    throw new Milestone4UsageError(
      `--apply-retention requires --confirm-retention ${RETENTION_CONFIRMATION}`,
      finalizeUsage,
    );
  }
  if (retentionMode !== 'apply' && parsed.values['confirm-retention'] !== undefined) {
    throw new Milestone4UsageError('--confirm-retention is only valid with --apply-retention', finalizeUsage);
  }
  let now: Date | undefined;
  if (parsed.values.now !== undefined) {
    now = new Date(parsed.values.now);
    if (Number.isNaN(now.getTime())) {
      throw new Milestone4UsageError('--now must be an ISO instant', finalizeUsage);
    }
  }
  const limit = boundedInteger(parsed.values.limit, '--limit', 1, 200, finalizeUsage);
  const graceSeconds = boundedInteger(parsed.values['grace-seconds'], '--grace-seconds', 0, 86_400, finalizeUsage);
  const monthGraceHours = boundedInteger(parsed.values['month-grace-hours'], '--month-grace-hours', 0, 168, finalizeUsage);
  const liveStateGraceSeconds = boundedInteger(
    parsed.values['live-state-grace-seconds'], '--live-state-grace-seconds', 0, 86_400, finalizeUsage,
  );
  const acknowledgeIncomplete = parsed.values['acknowledge-incomplete']?.trim();
  if (acknowledgeIncomplete !== undefined && (acknowledgeIncomplete.length < 1 || acknowledgeIncomplete.length > 200)) {
    throw new Milestone4UsageError('--acknowledge-incomplete must contain 1 through 200 characters', finalizeUsage);
  }
  if (acknowledgeIncomplete !== undefined && date === undefined) {
    throw new Milestone4UsageError('--acknowledge-incomplete requires --service-date', finalizeUsage);
  }
  return {
    ...(date === undefined ? {} : { serviceDate: date }),
    ...(month === undefined ? {} : { month }),
    ...(limit === undefined ? {} : { limit }),
    algorithmVersion: algorithmVersion(parsed.values['algorithm-version'], finalizeUsage),
    ...(now === undefined ? {} : { now }),
    ...(graceSeconds === undefined ? {} : { graceSeconds }),
    ...(monthGraceHours === undefined ? {} : { monthGraceHours }),
    ...(acknowledgeIncomplete === undefined ? {} : { acknowledgeIncomplete }),
    ...(liveStateGraceSeconds === undefined ? {} : { liveStateGraceSeconds }),
    retentionMode,
    help: false,
  };
}

async function runAggregate(
  options: AggregateCliOptions,
  dependencies: Milestone4Dependencies,
): Promise<0 | 1> {
  const config = loadConfig(dependencies.environment ?? process.env);
  const connection = await (dependencies.connect ?? createDatabaseConnection)(config.database);
  try {
    const report = await (dependencies.aggregate ?? aggregateDirty)({
      pool: connection.pool,
      algorithmVersion: options.algorithmVersion,
      ...(options.serviceDate === undefined ? {} : { serviceDate: options.serviceDate }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    (dependencies.stdout ?? process.stdout).write(`${JSON.stringify(report)}\n`);
    return report.failed === 0 ? 0 : 1;
  } finally {
    await connection.close();
  }
}

async function runFinalize(
  options: FinalizeCliOptions,
  dependencies: Milestone4Dependencies,
): Promise<0 | 1> {
  const config = loadConfig(dependencies.environment ?? process.env);
  const connection = await (dependencies.connect ?? createDatabaseConnection)(config.database);
  try {
    const report = await (dependencies.finalize ?? finalizeAnalytics)({
      pool: connection.pool,
      algorithmVersion: options.algorithmVersion,
      ...(options.serviceDate === undefined ? {} : { serviceDate: options.serviceDate }),
      ...(options.month === undefined ? {} : { month: options.month }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.graceSeconds === undefined ? {} : { graceSeconds: options.graceSeconds }),
      ...(options.monthGraceHours === undefined ? {} : { monthGraceHours: options.monthGraceHours }),
      ...(options.acknowledgeIncomplete === undefined ? {} : { acknowledgeIncomplete: options.acknowledgeIncomplete }),
      ...(options.liveStateGraceSeconds === undefined ? {} : { liveStateGraceSeconds: options.liveStateGraceSeconds }),
      retentionMode: options.retentionMode,
    });
    (dependencies.stdout ?? process.stdout).write(`${JSON.stringify(report)}\n`);
    return report.errors.length === 0 ? 0 : 1;
  } finally {
    await connection.close();
  }
}

function withAggregateCadence(
  arguments_: readonly string[],
  dependencies: Milestone4Dependencies,
): DispatcherDependencies {
  if (arguments_[0] !== 'ingest' || !arguments_.includes('--canonical-maintenance')) return dependencies;
  let nextAggregateAt = 0;
  let finalizationFailureActive = false;
  const now = dependencies.now ?? (() => new Date());
  const actualIngest = dependencies.realtimeIngest ?? runIngest;
  return {
    ...dependencies,
    ingest: async (options) => actualIngest({
      ...options,
      afterCycle: async () => {
        await options.afterCycle?.();
        const current = now().getTime();
        if (current < nextAggregateAt) return;
        const report = await (dependencies.aggregate ?? aggregateDirty)({ pool: options.pool, limit: 20 });
        if (report.failed > 0) throw new Error('Aggregate maintenance reported bounded errors');
        const finalization = await (dependencies.finalize ?? finalizeAnalytics)({
          pool: options.pool,
          limit: 7,
          now: new Date(current),
          retentionMode: 'none',
        });
        if (finalization.errors.length > 0 && !finalizationFailureActive) {
          options.onEvent?.('finalization.maintenance_failed', {
            errorCount: finalization.errors.length,
            errors: finalization.errors.slice(0, 10),
          });
          finalizationFailureActive = true;
        } else if (finalization.errors.length === 0 && finalizationFailureActive) {
          options.onEvent?.('finalization.maintenance_recovered', {});
          finalizationFailureActive = false;
        }
        nextAggregateAt = current + 5 * 60_000;
        options.onEvent?.('aggregate.maintenance', {
          scopesAttempted: report.scopesAttempted,
          succeeded: report.succeeded,
          noops: report.noops,
          serviceDaysFinalized: finalization.serviceDays.length,
          monthsSealed: finalization.months.length,
          finalizationErrors: finalization.errors.length,
        });
      },
    }),
  };
}

export async function executeMilestone4Cli(
  arguments_: readonly string[],
  dependencies: Milestone4Dependencies = {},
): Promise<ExitCode> {
  const stdout: Output = dependencies.stdout ?? process.stdout;
  const stderr: Output = dependencies.stderr ?? process.stderr;
  try {
    const first = arguments_[0];
    if ((first === '--help' || first === '-h') && arguments_.length === 1) {
      stdout.write(milestone4RootUsage);
      return 0;
    }
    if (first === 'aggregate') {
      const options = parseAggregate(arguments_.slice(1));
      if (options.help) {
        stdout.write(aggregateUsage);
        return 0;
      }
      return await runAggregate(options, dependencies);
    }
    if (first === 'finalize') {
      const options = parseFinalize(arguments_.slice(1));
      if (options.help) {
        stdout.write(finalizeUsage);
        return 0;
      }
      return await runFinalize(options, dependencies);
    }
    return await executeCli(arguments_, withAggregateCadence(arguments_, dependencies));
  } catch (error) {
    if (error instanceof Milestone4UsageError) {
      stderr.write(`${error.message}\n\n${error.usage}`);
      return 2;
    }
    const logger = createLogger({ service: 'atodotren-worker', level: 'error', output: stdout });
    if (error instanceof ConfigError) {
      logger.error('config.invalid', 'Environment configuration is invalid', { issues: error.issues });
    } else {
      logger.error('command.failed', 'Worker command failed', { error });
    }
    return 1;
  }
}
