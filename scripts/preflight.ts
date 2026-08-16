#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, statfs } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';

import { Client } from 'pg';

import {
  evaluateDiskSpace,
  inspectLocalEnvironment,
  parseEnvironmentFile,
  preflightExitCode,
  type PreflightCheck,
} from '../packages/config/src/preflight.ts';

const environmentPath = resolve(process.cwd(), process.argv[2] ?? '.env');
const commandTimeoutMs = 10_000;

interface CommandResult {
  readonly ok: boolean;
  readonly stdout: string;
}

function command(program: string, arguments_: readonly string[]): CommandResult {
  const result = spawnSync(program, arguments_, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: commandTimeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: result.status === 0, stdout: result.status === 0 ? result.stdout.trim() : '' };
}

function versionMajor(version: string): number | undefined {
  const match = /^(\d+)\./u.exec(version.trim());
  return match === null ? undefined : Number(match[1]);
}

function toolCheck(
  name: string,
  program: string,
  arguments_: readonly string[],
  successMessage: string,
): PreflightCheck {
  const result = command(program, arguments_);
  return {
    name,
    status: result.ok ? 'pass' : 'fail',
    message: result.ok ? successMessage : `${name} is unavailable`,
  };
}

async function portAcceptsConnections(hostname: string, port: number): Promise<boolean> {
  return new Promise((resolveConnection) => {
    const socket = connect({ host: hostname, port });
    const finish = (result: boolean): void => {
      socket.destroy();
      resolveConnection(result);
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function printCheck(check: PreflightCheck): void {
  process.stdout.write(`[${check.status.toUpperCase()}] ${check.name}: ${check.message}\n`);
}

function unavailableDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  return ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(code);
}

async function inspectMigrations(connectionUrl: string): Promise<{
  readonly repository: readonly string[];
  readonly pending: readonly string[];
}> {
  const migrationsDirectory = resolve(process.cwd(), 'migrations');
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (names.length === 0) {
    throw new Error('No repository migrations found');
  }
  const repository = new Map<string, string>();
  for (const name of names) {
    const sql = await readFile(resolve(migrationsDirectory, name), 'utf8');
    repository.set(name, createHash('sha256').update(sql).digest('hex'));
  }

  const client = new Client({
    connectionString: connectionUrl,
    connectionTimeoutMillis: 1_500,
    statement_timeout: 5_000,
    application_name: 'atodotren-preflight',
  });
  try {
    await client.connect();
    await client.query('SET ROLE atodotren_migration_admin');
    const relation = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('operations.schema_migration') IS NOT NULL AS exists",
    );
    const applied = new Map<string, string>();
    if (relation.rows[0]?.exists === true) {
      const result = await client.query<{ name: string; checksum: string }>(
        'SELECT name, checksum FROM operations.schema_migration ORDER BY name',
      );
      for (const row of result.rows) {
        applied.set(row.name, row.checksum);
      }
    }
    for (const [name, checksum] of applied) {
      if (!repository.has(name) || repository.get(name) !== checksum) {
        throw new Error('Applied migration state is inconsistent with the repository');
      }
    }
    return {
      repository: names,
      pending: names.filter((name) => !applied.has(name)),
    };
  } finally {
    await client.query('RESET ROLE').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const checks: PreflightCheck[] = [];
  const nodeMajor = versionMajor(process.versions.node);
  checks.push({
    name: 'runtime.node',
    status: nodeMajor === 24 ? 'pass' : 'fail',
    message:
      nodeMajor === 24
        ? `Node.js ${process.versions.node} is supported`
        : 'Node.js 24.x is required',
  });

  const npmVersion = command('npm', ['--version']);
  const npmMajor = npmVersion.ok ? versionMajor(npmVersion.stdout) : undefined;
  checks.push({
    name: 'runtime.npm',
    status: npmMajor === 11 ? 'pass' : 'fail',
    message: npmMajor === 11 ? `npm ${npmVersion.stdout} is supported` : 'npm 11.x is required',
  });

  checks.push(toolCheck('docker.cli', 'docker', ['--version'], 'Docker CLI is available'));
  const daemon = toolCheck(
    'docker.daemon',
    'docker',
    ['info', '--format', '{{.ServerVersion}}'],
    'Docker daemon is available',
  );
  checks.push(daemon);
  checks.push(
    toolCheck(
      'docker.compose',
      'docker',
      ['compose', 'version'],
      'Docker Compose v2 is available',
    ),
  );
  checks.push(
    toolCheck(
      'docker.buildx',
      'docker',
      ['buildx', 'version'],
      'Docker Buildx is available',
    ),
  );

  let environment: Readonly<Record<string, string>>;
  try {
    environment = parseEnvironmentFile(await readFile(environmentPath, 'utf8'));
    checks.push({
      name: 'environment.file',
      status: 'pass',
      message: 'Local environment file is readable',
    });
  } catch {
    checks.push({
      name: 'environment.file',
      status: 'fail',
      message: 'Local environment file is missing or unreadable',
    });
    checks.forEach(printCheck);
    return 1;
  }
  checks.push(...inspectLocalEnvironment(environment));

  const ignored = command('git', ['check-ignore', '--quiet', environmentPath]);
  checks.push({
    name: 'git.environment-ignore',
    status: ignored.ok ? 'pass' : 'fail',
    message: ignored.ok ? 'Local environment file is ignored by Git' : 'Local environment file is not ignored by Git',
  });

  const disk = await statfs(process.cwd());
  checks.push(evaluateDiskSpace(Number(disk.bavail) * Number(disk.bsize)));

  const port = Number(environment.POSTGRES_PORT);
  const primaryContainer =
    daemon.status === 'pass'
      ? command('docker', [
          'compose',
          '--project-name',
          'atodotren',
          '--env-file',
          environmentPath,
          'ps',
          '--all',
          '--quiet',
          'postgres',
        ]).stdout
      : '';
  let primaryRunning = false;
  if (primaryContainer === '') {
    checks.push({
      name: 'postgres.container-health',
      status: 'warn',
      message: 'Primary local PostgreSQL is not running; health check is deferred',
    });
  } else {
    const state = command('docker', [
      'inspect',
      '--format',
      '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
      primaryContainer,
    ]);
    primaryRunning = state.ok && state.stdout === 'true healthy';
    checks.push({
      name: 'postgres.container-health',
      status: primaryRunning ? 'pass' : state.stdout.startsWith('false ') ? 'warn' : 'fail',
      message: primaryRunning
        ? 'Primary local PostgreSQL container is healthy'
        : state.stdout.startsWith('false ')
          ? 'Primary local PostgreSQL container is stopped; health check is deferred'
          : 'Primary local PostgreSQL container is running but not healthy',
    });
  }

  if (Number.isSafeInteger(port) && port >= 1 && port <= 65_535) {
    const portInUse = await portAcceptsConnections('127.0.0.1', port);
    checks.push({
      name: 'postgres.host-port',
      status: !portInUse || primaryRunning ? 'pass' : 'fail',
      message: !portInUse
        ? 'Configured PostgreSQL host port is available'
        : primaryRunning
          ? 'Configured PostgreSQL host port belongs to the healthy primary stack'
          : 'Configured PostgreSQL host port is occupied outside the healthy primary stack',
    });
  }

  if (checks.some((check) => check.name.startsWith('database.') && check.status === 'fail')) {
    checks.push({
      name: 'database.migrations',
      status: 'warn',
      message: 'Migration and checksum checks are deferred until static URL checks pass',
    });
  } else {
    try {
      const migrationState = await inspectMigrations(environment.MIGRATION_DATABASE_URL ?? '');
      checks.push({
        name: 'database.migrations',
        status: migrationState.pending.length === 0 ? 'pass' : 'fail',
        message:
          migrationState.pending.length === 0
            ? `Migration state and ${migrationState.repository.length} checksum(s) are consistent`
            : `Pending migrations: ${migrationState.pending.join(', ')}`,
      });
    } catch (error) {
      checks.push({
        name: 'database.migrations',
        status: unavailableDatabaseError(error) ? 'warn' : 'fail',
        message: unavailableDatabaseError(error)
          ? 'PostgreSQL is unreachable; migration and checksum checks are deferred'
          : 'Migration state or checksum verification failed',
      });
    }
  }

  checks.forEach(printCheck);
  const exitCode = preflightExitCode(checks);
  process.stdout.write(
    `Preflight ${exitCode === 0 ? 'passed' : 'failed'}: ${checks.filter((check) => check.status === 'pass').length} pass, ${checks.filter((check) => check.status === 'warn').length} warn, ${checks.filter((check) => check.status === 'fail').length} fail.\n`,
  );
  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    process.stderr.write('[FAIL] preflight.internal: Preflight failed unexpectedly; sensitive details were suppressed\n');
    process.exitCode = 1;
  });
