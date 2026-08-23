#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';

import { Client } from 'pg';
import { readMigrationInventory, reconcileMigrationState } from '@atodotren/db';

import {
  evaluateDiskSpace,
  evaluatePrimaryPostgres,
  evaluateTelegramRoleContract,
  inspectLocalEnvironment,
  parseEnvironmentFile,
  preflightExitCode,
  type PreflightCheck,
  type TelegramRoleContractState,
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
  if (!(error instanceof Error)) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  return code.startsWith('08') || ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(code);
}

async function inspectMigrations(connectionUrl: string, migrationsDirectory: string): Promise<{
  readonly repository: readonly string[];
  readonly pending: readonly string[];
}> {
  const inventory = await readMigrationInventory(migrationsDirectory);
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
    const applied: Array<{ name: string; checksum: string }> = [];
    if (relation.rows[0]?.exists === true) {
      const result = await client.query<{ name: string; checksum: string }>(
        'SELECT name, checksum FROM operations.schema_migration ORDER BY name',
      );
      applied.push(...result.rows);
    }
    const state = reconcileMigrationState(inventory, applied);
    return {
      repository: inventory.map((migration) => migration.name),
      pending: state.pending.map((migration) => migration.name),
    };
  } finally {
    await client.query('RESET ROLE').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function inspectTelegramRoleContract(connectionUrl: string): Promise<TelegramRoleContractState> {
  const client = new Client({
    connectionString: connectionUrl,
    connectionTimeoutMillis: 1_500,
    statement_timeout: 5_000,
    application_name: 'atodotren-preflight-reporting',
  });
  try {
    await client.connect();
    const current = await client.query<{ current_user: string }>('SELECT current_user');
    const roles = await client.query<{
      rolname: string;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(`SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      FROM pg_roles WHERE rolname IN ('atodotren_telegram', 'atodotren_reporting_reader')`);
    const memberships = await client.query<{
      role: string;
      admin_option: boolean;
      inherit_option: boolean;
      set_option: boolean;
    }>(`SELECT granted.rolname AS role, membership.admin_option, membership.inherit_option, membership.set_option
      FROM pg_auth_members AS membership
      JOIN pg_roles AS member ON member.oid = membership.member
      JOIN pg_roles AS granted ON granted.oid = membership.roleid
      WHERE member.rolname = 'atodotren_telegram'`);
    const login = roles.rows.find((role) => role.rolname === 'atodotren_telegram');
    const reporting = roles.rows.find((role) => role.rolname === 'atodotren_reporting_reader');
    const unsafe = (role: typeof login): boolean => role === undefined
      || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls;
    return {
      currentUser: current.rows[0]?.current_user ?? '',
      loginExists: login !== undefined && login.rolcanlogin,
      loginUnsafe: unsafe(login),
      reportingRoleExists: reporting !== undefined && !reporting.rolcanlogin,
      reportingRoleUnsafe: unsafe(reporting),
      directMemberships: memberships.rows.map((membership) => ({
        role: membership.role,
        admin: membership.admin_option,
        inherit: membership.inherit_option,
        set: membership.set_option,
      })),
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const checks: PreflightCheck[] = [];
  const nodeMajor = versionMajor(process.versions.node);
  checks.push({
    name: 'runtime.node',
    status: nodeMajor === 24 ? 'pass' : 'fail',
    message: nodeMajor === 24 ? `Node.js ${process.versions.node} is supported` : 'Node.js 24.x is required',
  });

  const npmVersion = command('npm', ['--version']);
  const npmMajor = npmVersion.ok ? versionMajor(npmVersion.stdout) : undefined;
  checks.push({
    name: 'runtime.npm',
    status: npmMajor === 11 ? 'pass' : 'fail',
    message: npmMajor === 11 ? `npm ${npmVersion.stdout} is supported` : 'npm 11.x is required',
  });

  checks.push(toolCheck('docker.cli', 'docker', ['--version'], 'Docker CLI is available'));
  const daemon = toolCheck('docker.daemon', 'docker', ['info', '--format', '{{.ServerVersion}}'], 'Docker daemon is available');
  checks.push(daemon);
  checks.push(toolCheck('docker.compose', 'docker', ['compose', 'version'], 'Docker Compose v2 is available'));
  checks.push(toolCheck('docker.buildx', 'docker', ['buildx', 'version'], 'Docker Buildx is available'));

  let environment: Readonly<Record<string, string>>;
  try {
    environment = parseEnvironmentFile(await readFile(environmentPath, 'utf8'));
    checks.push({ name: 'environment.file', status: 'pass', message: 'Local environment file is readable' });
  } catch {
    checks.push({ name: 'environment.file', status: 'fail', message: 'Local environment file is missing or unreadable' });
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
  const primaryContainer = daemon.status === 'pass'
    ? command('docker', ['compose', '--project-name', 'atodotren', '--env-file', environmentPath, 'ps', '--all', '--quiet', 'postgres']).stdout
    : '';
  let primaryHealthy = false;
  const portInUse = Number.isSafeInteger(port) && port >= 1 && port <= 65_535
    ? await portAcceptsConnections('127.0.0.1', port)
    : false;
  if (primaryContainer === '') {
    checks.push(...evaluatePrimaryPostgres(
      { exists: false, running: false, health: 'absent', hostPorts: [] },
      port,
      portInUse,
    ));
  } else {
    const state = command('docker', ['inspect', '--format', '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', primaryContainer]);
    const [running = 'false', health = 'unknown'] = state.stdout.split(' ');
    const binding = command('docker', ['inspect', '--format', '{{json (index .NetworkSettings.Ports "5432/tcp")}}', primaryContainer]);
    let hostPorts: number[];
    try {
      const parsed = JSON.parse(binding.stdout) as readonly { HostPort?: string }[] | null;
      hostPorts = (parsed ?? []).map((entry) => Number(entry.HostPort)).filter((hostPort) => Number.isSafeInteger(hostPort));
    } catch {
      hostPorts = [];
    }
    primaryHealthy = state.ok && running === 'true' && health === 'healthy';
    checks.push(...evaluatePrimaryPostgres(
      { exists: true, running: running === 'true', health, hostPorts },
      port,
      portInUse,
    ));
  }

  let migrationsCurrent = false;
  let reportingMigrationPresent = false;
  if (checks.some((check) => check.name.startsWith('database.') && check.status === 'fail')) {
    checks.push({
      name: 'database.migrations',
      status: 'warn',
      message: 'Migration, checksum, and reporting-role checks are deferred until static URL checks pass',
    });
  } else {
    try {
      const migrationState = await inspectMigrations(
        environment.MIGRATION_DATABASE_URL ?? '',
        environment.MIGRATIONS_DIR ?? process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), 'migrations'),
      );
      migrationsCurrent = migrationState.pending.length === 0;
      reportingMigrationPresent = migrationState.repository.includes('0009_reporting_telegram.sql');
      checks.push({
        name: 'database.migrations',
        status: migrationsCurrent ? 'pass' : 'fail',
        message: migrationsCurrent
          ? `Migration state and ${migrationState.repository.length} checksum(s) are consistent`
          : `Pending migrations: ${migrationState.pending.join(', ')}`,
      });
    } catch (error) {
      checks.push({
        name: 'database.migrations',
        status: unavailableDatabaseError(error) && !primaryHealthy ? 'warn' : 'fail',
        message: unavailableDatabaseError(error)
          ? primaryHealthy
            ? 'Primary PostgreSQL is healthy but the configured migration URL is unreachable'
            : 'PostgreSQL is unreachable; migration, checksum, and reporting-role checks are deferred'
          : 'Migration state or checksum verification failed',
      });
    }
  }

  if (migrationsCurrent && reportingMigrationPresent) {
    try {
      checks.push(evaluateTelegramRoleContract(await inspectTelegramRoleContract(environment.REPORT_DATABASE_URL ?? '')));
    } catch (error) {
      checks.push({
        name: 'database.telegram-role-contract',
        status: unavailableDatabaseError(error) && !primaryHealthy ? 'warn' : 'fail',
        message: unavailableDatabaseError(error) && !primaryHealthy
          ? 'Reporting database is unavailable because the primary stack is unavailable; Telegram role validation is deferred'
          : 'Telegram reporting login could not validate its exact role/membership contract',
      });
    }
  } else {
    checks.push({
      name: 'database.telegram-role-contract',
      status: 'warn',
      message: 'Telegram reporting role validation is deferred until migration 0009 is present and applied',
    });
  }

  checks.forEach(printCheck);
  const exitCode = preflightExitCode(checks);
  process.stdout.write(
    `Preflight ${exitCode === 0 ? 'passed' : 'failed'}: ${checks.filter((check) => check.status === 'pass').length} pass, ${checks.filter((check) => check.status === 'warn').length} warn, ${checks.filter((check) => check.status === 'fail').length} fail.\n`,
  );
  return exitCode;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch(() => {
    process.stderr.write('[FAIL] preflight.internal: Preflight failed unexpectedly; sensitive details were suppressed\n');
    process.exitCode = 1;
  });
