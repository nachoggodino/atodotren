export type Database = Record<never, never>;

export interface DatabaseConnectionOptions {
  readonly url: string;
  readonly sslMode: 'disable' | 'require' | 'verify-full';
  readonly caCertificatePath?: string;
  readonly poolMax: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly applicationName: string;
}

export interface DatabaseLogSink {
  debug(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
}
