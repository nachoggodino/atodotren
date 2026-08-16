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

function normalize(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.cause === undefined ? {} : { cause: normalize(value.cause) }),
    };
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

export function createLogger(options: LoggerOptions): Logger {
  const output = options.output ?? process.stdout;
  const now = options.now ?? (() => new Date());

  const write = (level: LogLevel, event: string, message: string, fields?: LogFields): void => {
    if (levelPriority[level] < levelPriority[options.level]) {
      return;
    }
    const normalizedFields = Object.fromEntries(
      Object.entries(fields ?? {}).map(([key, value]) => [key, normalize(value)]),
    );
    output.write(
      `${JSON.stringify({
        timestamp: now().toISOString(),
        level,
        service: options.service,
        event,
        message,
        ...normalizedFields,
      })}\n`,
    );
  };

  return {
    debug: (event, message, fields) => {
      write('debug', event, message, fields);
    },
    info: (event, message, fields) => {
      write('info', event, message, fields);
    },
    warn: (event, message, fields) => {
      write('warn', event, message, fields);
    },
    error: (event, message, fields) => {
      write('error', event, message, fields);
    },
  };
}
