import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import { createLogger } from '@atodotren/observability';

function capture(now: () => Date = () => new Date('2026-08-16T12:00:00.000Z')) {
  let output = '';
  const stream = new Writable({ write(chunk: Buffer, _encoding, callback) { output += chunk.toString('utf8'); callback(); } });
  return {
    logger: createLogger({ service: 'test-service', level: 'debug', output: stream, now }),
    records: () => output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown),
  };
}

void test('reserved fields cannot spoof the structured envelope', () => {
  const output = capture();
  output.logger.info('real.event', 'real message', {
    timestamp: 'spoofed', level: 'error', service: 'spoofed', event: 'spoofed', message: 'spoofed',
  });
  assert.deepEqual(output.records()[0], {
    timestamp: '2026-08-16T12:00:00.000Z', level: 'info', service: 'test-service',
    event: 'real.event', message: 'real message',
  });
});

void test('recursively normalizes arrays, bigint, circular values, causes, and PostgreSQL metadata', () => {
  const output = capture();
  const circular: Record<string, unknown> = { values: [1n, { size: 2n }] };
  circular.self = circular;
  const error = new Error('database failed', { cause: new Error('inner') }) as Error & Record<string, unknown>;
  Object.assign(error, {
    code: '23505', severity: 'ERROR', detail: 'duplicate', schema: 'core', table: 'station',
    column: 'slug', constraint: 'station_slug_key', where: 'statement',
  });
  output.logger.error('database.error', 'failed', {
    circular,
    error,
    observedAt: new Date('2026-08-17T04:00:00.000Z'),
  });
  const record = output.records()[0] as {
    circular: { values: unknown; self: string };
    error: Record<string, unknown> & { cause: { message: string } };
    observedAt: string;
  };
  assert.deepEqual(record.circular.values, ['1', { size: '2' }]);
  assert.equal(record.circular.self, '[Circular]');
  assert.equal(record.error.cause.message, 'inner');
  assert.equal(record.observedAt, '2026-08-17T04:00:00.000Z');
  assert.deepEqual(
    Object.fromEntries(['code', 'severity', 'detail', 'schema', 'table', 'column', 'constraint', 'where'].map((key) => [key, record.error[key]])),
    {
      code: '23505', severity: 'ERROR', detail: 'duplicate', schema: 'core', table: 'station',
      column: 'slug', constraint: 'station_slug_key', where: 'statement',
    },
  );
});

void test('redacts credential fields and PostgreSQL connection URLs at every depth', () => {
  const output = capture();
  output.logger.error('safe', 'postgresql://worker:secret@localhost:5432/atodotren failed', {
    password: 'secret', nested: { token: 'token-value', url: 'postgres://user:pass@example.test/db' },
  });
  const serialized = JSON.stringify(output.records());
  assert.doesNotMatch(serialized, /secret|token-value|user:pass/u);
  assert.match(serialized, /REDACTED/u);
});

void test('serialization and output failures cannot escape the logger', () => {
  const fallback = capture(() => { throw new Error('clock unavailable'); });
  assert.doesNotThrow(() => fallback.logger.error('x', 'y', { value: 1n }));
  assert.equal((fallback.records()[0] as Record<string, unknown>).event, 'logging.serialization_failed');
  const logger = createLogger({
    service: 'test', level: 'info', output: { write: () => { throw new Error('broken stream'); } },
  });
  assert.doesNotThrow(() => logger.info('x', 'y'));
});
