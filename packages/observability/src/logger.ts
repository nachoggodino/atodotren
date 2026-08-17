export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(event: string, message: string, fields?: LogFields): void;
  info(event: string, message: string, fields?: LogFields): void;
  warn(event: string, message: string, fields?: LogFields): void;
  error(event: string, message: string, fields?: LogFields): void;
}

interface LoggerOptions {
  readonly service: string;
  readonly level: LogLevel;
  readonly output?: Pick<NodeJS.WritableStream, 'write'>;
  readonly now?: () => Date;
}

const levelPriority: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const reservedFields = new Set(['timestamp', 'level', 'service', 'event', 'message']);
const sensitiveKey = /(?:authorization|credential|database_?url|password|secret|token)/iu;
const postgresUrl = /\bpostgres(?:ql)?:\/\/[^\s"'<>]+/giu;
const errorProperties = [
  'code',
  'severity',
  'detail',
  'schema',
  'table',
  'column',
  'constraint',
  'where',
] as const;
const maximumDepth = 8;
const maximumEntries = 100;
const maximumStringLength = 8_192;

function safeString(value: string): string {
  const redacted = value.replace(postgresUrl, '[REDACTED_DATABASE_URL]');
  return redacted.length <= maximumStringLength
    ? redacted
    : `${redacted.slice(0, maximumStringLength)}[Truncated]`;
}

function normalize(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  key?: string,
): unknown {
  if (key !== undefined && sensitiveKey.test(key)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') {
    return safeString(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return value;
  }
  if (typeof value === 'symbol') {
    return value.description === undefined ? '[Symbol]' : `[Symbol: ${safeString(value.description)}]`;
  }
  if (typeof value === 'function') {
    return '[Function]';
  }
  if (depth >= maximumDepth) {
    return '[MaxDepth]';
  }
  if (typeof value !== 'object') {
    return '[Unsupported]';
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[InvalidDate]' : value.toISOString();
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  try {
    if (value instanceof Error) {
      const normalized: Record<string, unknown> = {
        name: safeString(value.name),
        message: safeString(value.message),
      };
      if (value.stack !== undefined) {
        normalized.stack = safeString(value.stack);
      }
      if (value.cause !== undefined) {
        normalized.cause = normalize(value.cause, seen, depth + 1, 'cause');
      }
      for (const property of errorProperties) {
        try {
          const propertyValue = (value as unknown as Record<string, unknown>)[property];
          if (propertyValue !== undefined) {
            normalized[property] = normalize(propertyValue, seen, depth + 1, property);
          }
        } catch {
          normalized[property] = '[Unserializable]';
        }
      }
      return normalized;
    }
    if (Array.isArray(value)) {
      const normalized = value
        .slice(0, maximumEntries)
        .map((entry) => normalize(entry, seen, depth + 1));
      if (value.length > maximumEntries) {
        normalized.push(`[${value.length - maximumEntries} more items]`);
      }
      return normalized;
    }

    const normalized: Record<string, unknown> = {};
    let entries: readonly [string, unknown][];
    try {
      entries = Object.entries(value).slice(0, maximumEntries);
    } catch {
      return '[Unserializable]';
    }
    for (const [property, propertyValue] of entries) {
      if (property === 'toJSON') {
        continue;
      }
      try {
        normalized[property] = normalize(propertyValue, seen, depth + 1, property);
      } catch {
        normalized[property] = '[Unserializable]';
      }
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const output = options.output ?? process.stdout;
  const now = options.now ?? (() => new Date());

  const write = (level: LogLevel, event: string, message: string, fields?: LogFields): void => {
    if (levelPriority[level] < levelPriority[options.level]) {
      return;
    }
    let line: string;
    try {
      const normalizedFields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields ?? {})) {
        if (!reservedFields.has(key)) {
          normalizedFields[key] = normalize(value, new WeakSet(), 0, key);
        }
      }
      line = JSON.stringify({
        ...normalizedFields,
        timestamp: now().toISOString(),
        level,
        service: safeString(options.service),
        event: safeString(event),
        message: safeString(message),
      });
    } catch {
      line = JSON.stringify({
        timestamp: new Date(0).toISOString(),
        level: 'error',
        service: 'atodotren-logger',
        event: 'logging.serialization_failed',
        message: 'Log record serialization failed',
      });
    }
    try {
      output.write(`${line}\n`);
    } catch {
      // Logging is a failure-reporting boundary and must never crash its caller.
    }
  };

  return {
    debug: (event, message, fields) => write('debug', event, message, fields),
    info: (event, message, fields) => write('info', event, message, fields),
    warn: (event, message, fields) => write('warn', event, message, fields),
    error: (event, message, fields) => write('error', event, message, fields),
  };
}
