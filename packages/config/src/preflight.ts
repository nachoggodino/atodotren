export type PreflightStatus = 'pass' | 'warn' | 'fail';

export interface PreflightCheck {
  readonly name: string;
  readonly status: PreflightStatus;
  readonly message: string;
}

export interface PrimaryPostgresState {
  readonly exists: boolean;
  readonly running: boolean;
  readonly health: string;
  readonly hostPorts: readonly number[];
}

type Environment = Readonly<Record<string, string | undefined>>;

const requiredLocalKeys = [
  'POSTGRES_DB',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'ATODOTREN_WORKER_PASSWORD',
  'POSTGRES_PORT',
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'TEST_ADMIN_DATABASE_URL',
  'TEST_MIGRATOR_DATABASE_URL',
  'TEST_WORKER_DATABASE_URL',
] as const;

const localUrlRequirements = {
  DATABASE_URL: { username: 'atodotren_worker', passwordKey: 'ATODOTREN_WORKER_PASSWORD' },
  MIGRATION_DATABASE_URL: { username: 'atodotren_migrator', passwordKey: 'POSTGRES_PASSWORD' },
  TEST_ADMIN_DATABASE_URL: { usernameKey: 'POSTGRES_USER', passwordKey: 'POSTGRES_PASSWORD' },
  TEST_MIGRATOR_DATABASE_URL: {
    username: 'atodotren_migrator',
    passwordKey: 'POSTGRES_PASSWORD',
  },
  TEST_WORKER_DATABASE_URL: {
    username: 'atodotren_worker',
    passwordKey: 'ATODOTREN_WORKER_PASSWORD',
  },
} as const;

const placeholderPattern = /(?:\$\{[^}]+\}|<[^>]+>|change[-_ ]?me|replace[-_ ]?me|placeholder)/i;
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

function decodeUrlPart(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function parseEnvironmentFile(contents: string): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (match === null) {
      continue;
    }
    const key = match[1];
    let value = match[2]?.trim() ?? '';
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

export function inspectLocalEnvironment(environment: Environment): readonly PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  const missing = requiredLocalKeys.filter((key) => (environment[key]?.trim() ?? '') === '');
  checks.push({
    name: 'environment.required',
    status: missing.length === 0 ? 'pass' : 'fail',
    message:
      missing.length === 0
        ? 'All required local variables are set'
        : `Missing required variables: ${missing.join(', ')}`,
  });

  const placeholders = requiredLocalKeys.filter((key) =>
    placeholderPattern.test(environment[key] ?? ''),
  );
  checks.push({
    name: 'environment.placeholders',
    status: placeholders.length === 0 ? 'pass' : 'fail',
    message:
      placeholders.length === 0
        ? 'No unresolved placeholder values were found'
        : `Unresolved placeholders remain in: ${placeholders.join(', ')}`,
  });

  const expectedPort = environment.POSTGRES_PORT ?? '';
  const portNumber = Number(expectedPort);
  const validPort = Number.isSafeInteger(portNumber) && portNumber >= 1 && portNumber <= 65_535;
  const expectedDatabase = environment.POSTGRES_DB ?? '';
  const invalidUrls: string[] = [];
  const invalidShapes: string[] = [];
  const incoherentPasswords: string[] = [];

  if (expectedDatabase !== 'atodotren') {
    invalidShapes.push('POSTGRES_DB');
  }
  if (environment.POSTGRES_USER !== 'postgres') {
    invalidShapes.push('POSTGRES_USER');
  }

  for (const [key, requirement] of Object.entries(localUrlRequirements)) {
    const raw = environment[key];
    if (raw === undefined || raw.trim() === '') {
      continue;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      invalidUrls.push(key);
      continue;
    }
    const database = decodeUrlPart(url.pathname.slice(1));
    const username = decodeUrlPart(url.username);
    const password = decodeUrlPart(url.password);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      username === undefined ||
      username === '' ||
      password === undefined ||
      password === '' ||
      database === undefined ||
      database === ''
    ) {
      invalidUrls.push(key);
      continue;
    }
    const expectedUsername =
      'username' in requirement
        ? requirement.username
        : environment[requirement.usernameKey] ?? '';
    if (
      username !== expectedUsername ||
      !localHosts.has(url.hostname) ||
      url.port !== expectedPort ||
      database !== expectedDatabase
    ) {
      invalidShapes.push(key);
    }
    if (password !== (environment[requirement.passwordKey] ?? '')) {
      incoherentPasswords.push(key);
    }
  }

  checks.push({
    name: 'database.urls',
    status: invalidUrls.length === 0 && validPort ? 'pass' : 'fail',
    message:
      invalidUrls.length === 0 && validPort
        ? 'All local PostgreSQL URLs and the host port are valid'
        : `Invalid local PostgreSQL URL/port fields: ${[
            ...invalidUrls,
            ...(validPort ? [] : ['POSTGRES_PORT']),
          ].join(', ')}`,
  });
  checks.push({
    name: 'database.local-shape',
    status: invalidShapes.length === 0 ? 'pass' : 'fail',
    message:
      invalidShapes.length === 0
        ? 'Local URL usernames, database, hosts, and ports match the local contract'
        : `Local URL shape is inconsistent for: ${invalidShapes.join(', ')}`,
  });
  checks.push({
    name: 'database.password-coherence',
    status: incoherentPasswords.length === 0 ? 'pass' : 'fail',
    message:
      incoherentPasswords.length === 0
        ? 'Local URL passwords match their component variables'
        : `URL/component password mismatch for: ${incoherentPasswords.join(', ')}`,
  });
  return checks;
}

export function preflightExitCode(checks: readonly PreflightCheck[]): 0 | 1 {
  return checks.some((check) => check.status === 'fail') ? 1 : 0;
}

export function evaluatePrimaryPostgres(
  state: PrimaryPostgresState,
  expectedPort: number,
  configuredPortAcceptsConnections: boolean,
): readonly PreflightCheck[] {
  if (!state.exists) {
    return [
      {
        name: 'postgres.container-health',
        status: 'warn',
        message: 'Primary local PostgreSQL is absent; live health checks are deferred',
      },
      {
        name: 'postgres.port-binding',
        status: 'warn',
        message: 'Primary PostgreSQL port binding is absent because the stack is not created',
      },
      {
        name: 'postgres.host-port',
        status: configuredPortAcceptsConnections ? 'fail' : 'pass',
        message: configuredPortAcceptsConnections
          ? 'Configured PostgreSQL host port is occupied by an unrelated listener'
          : 'Configured PostgreSQL host port is available',
      },
    ];
  }

  const healthy = state.running && state.health === 'healthy';
  const healthCheck: PreflightCheck = {
    name: 'postgres.container-health',
    status: healthy ? 'pass' : state.running ? 'fail' : 'warn',
    message: healthy
      ? 'Primary local PostgreSQL container is healthy'
      : state.running
        ? `Primary local PostgreSQL container is unhealthy (${state.health})`
        : 'Primary local PostgreSQL container is stopped; live health checks are deferred',
  };
  const bindingMatches =
    state.hostPorts.length > 0 && state.hostPorts.every((port) => port === expectedPort);
  const bindingCheck: PreflightCheck = {
    name: 'postgres.port-binding',
    status: bindingMatches ? 'pass' : 'fail',
    message:
      state.hostPorts.length === 0
        ? 'Primary PostgreSQL container has no published 5432/tcp host binding'
        : bindingMatches
          ? 'Primary PostgreSQL 5432/tcp binding matches POSTGRES_PORT'
          : 'Primary PostgreSQL 5432/tcp binding does not match POSTGRES_PORT',
  };
  const hostPortCheck: PreflightCheck = {
    name: 'postgres.host-port',
    status: healthy && bindingMatches && configuredPortAcceptsConnections ? 'pass' : 'fail',
    message:
      healthy && bindingMatches && configuredPortAcceptsConnections
        ? 'Configured PostgreSQL host port belongs to the healthy primary stack'
        : 'Configured PostgreSQL host port does not reach the healthy primary stack',
  };
  return [healthCheck, bindingCheck, hostPortCheck];
}

export function evaluateDiskSpace(
  availableBytes: number,
  warningBytes = 10 * 1024 ** 3,
  failureBytes = 2 * 1024 ** 3,
): PreflightCheck {
  if (availableBytes < failureBytes) {
    return {
      name: 'disk.space',
      status: 'fail',
      message: 'Available disk space is below the 2 GiB blocking threshold',
    };
  }
  if (availableBytes < warningBytes) {
    return {
      name: 'disk.space',
      status: 'warn',
      message: 'Available disk space is below the 10 GiB warning threshold',
    };
  }
  return {
    name: 'disk.space',
    status: 'pass',
    message: 'Available disk space meets the 10 GiB warning threshold',
  };
}
