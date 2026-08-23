import { parseArgs } from 'node:util';

import { ConfigError, loadConfig } from '@atodotren/config';
import { createDatabaseConnection } from '@atodotren/db';
import { createLogger } from '@atodotren/observability';

import { executeMilestone4Cli, milestone4RootUsage, type Milestone4Dependencies } from './m4-cli.js';
import { incidentsReport, formatReportText, pilotReport, statusReport } from './reporting-operations.js';
import { parseReportDate, type ReportResult } from './reporting-core.js';
import { ReportingService } from './reporting-service.js';

type ExitCode = 0 | 1 | 2;
type Output = Pick<NodeJS.WritableStream, 'write'>;

export const reportUsage = `Usage:
  worker report [--kind daily|status|incidents|pilot] [--date <YYYY-MM-DD|yesterday>] [--json | --text]

Emits a bounded provider-neutral operational report. JSON is the default stable
machine contract; --text emits concise human-readable text. Daily dates use
Europe/Madrid service-day semantics and always include coverage/sample size.
`;

export const milestone5RootUsage = milestone4RootUsage
  .replace('Emit operational reports (planned for a later milestone)', 'Emit bounded provider-neutral operational reports');

export interface Milestone5Dependencies extends Milestone4Dependencies {
  readonly reportNow?: () => Date;
}

interface ReportOptions {
  readonly kind: 'daily' | 'status' | 'incidents' | 'pilot';
  readonly date?: string;
  readonly format: 'json' | 'text';
  readonly help: boolean;
}

class Milestone5UsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'Milestone5UsageError';
  }
}

function parseReportOptions(arguments_: readonly string[], now: Date): ReportOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...arguments_], allowPositionals: false, strict: true,
      options: {
        kind: { type: 'string' }, date: { type: 'string' }, json: { type: 'boolean' }, text: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new Milestone5UsageError(error instanceof Error ? error.message : 'Invalid report options');
  }
  if (parsed.values.help === true) return { kind: 'daily', format: 'json', help: true };
  if (parsed.values.json === true && parsed.values.text === true) throw new Milestone5UsageError('--json and --text are mutually exclusive');
  const kind = parsed.values.kind ?? 'daily';
  if (!['daily', 'status', 'incidents', 'pilot'].includes(kind)) throw new Milestone5UsageError('--kind must be daily, status, incidents, or pilot');
  if (kind !== 'daily' && parsed.values.date !== undefined) throw new Milestone5UsageError('--date is only valid for --kind daily');
  const date = parsed.values.date === undefined ? undefined : parseReportDate(parsed.values.date, now);
  return {
    kind: kind as ReportOptions['kind'], ...(date === undefined ? {} : { date }),
    format: parsed.values.text === true ? 'text' : 'json', help: false,
  };
}

async function runReport(options: ReportOptions, dependencies: Milestone5Dependencies): Promise<0 | 1> {
  const environment = dependencies.environment ?? process.env;
  const reportEnvironment = environment.REPORT_DATABASE_URL === undefined
    ? environment
    : { ...environment, DATABASE_URL: environment.REPORT_DATABASE_URL };
  const config = loadConfig(reportEnvironment);
  const connection = await (dependencies.connect ?? createDatabaseConnection)({
    ...config.database,
    applicationName: 'atodotren-report-cli',
    statementTimeoutMs: Math.min(config.database.statementTimeoutMs, 5_000),
  });
  try {
    const reporting = new ReportingService(connection.pool, dependencies.reportNow ?? (() => new Date()));
    let report: ReportResult;
    if (options.kind === 'status') report = await statusReport(reporting);
    else if (options.kind === 'incidents') report = await incidentsReport(reporting);
    else if (options.kind === 'pilot') report = await pilotReport(reporting);
    else report = await reporting.daily(options.date);
    (dependencies.stdout ?? process.stdout).write(options.format === 'json' ? `${JSON.stringify(report)}\n` : `${formatReportText(report)}\n`);
    return 0;
  } finally {
    await connection.close();
  }
}

export async function executeMilestone5Cli(
  arguments_: readonly string[],
  dependencies: Milestone5Dependencies = {},
): Promise<ExitCode> {
  const stdout: Output = dependencies.stdout ?? process.stdout;
  const stderr: Output = dependencies.stderr ?? process.stderr;
  try {
    const first = arguments_[0];
    if ((first === '--help' || first === '-h') && arguments_.length === 1) {
      stdout.write(milestone5RootUsage);
      return 0;
    }
    if (first !== 'report') return await executeMilestone4Cli(arguments_, dependencies);
    const now = (dependencies.reportNow ?? (() => new Date()))();
    const options = parseReportOptions(arguments_.slice(1), now);
    if (options.help) {
      stdout.write(reportUsage);
      return 0;
    }
    return await runReport(options, dependencies);
  } catch (error) {
    if (error instanceof Milestone5UsageError || error instanceof RangeError) {
      stderr.write(`${error.message}\n\n${reportUsage}`);
      return 2;
    }
    const logger = createLogger({ service: 'atodotren-worker', level: 'error', output: stdout });
    if (error instanceof ConfigError) logger.error('config.invalid', 'Environment configuration is invalid', { issues: error.issues });
    else logger.error('command.failed', 'Worker command failed', { error });
    return 1;
  }
}
