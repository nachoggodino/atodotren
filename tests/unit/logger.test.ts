import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import { createLogger } from '@atodotren/observability';

void test('emits one structured JSON object per log event', () => {
  let output = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      output += chunk.toString('utf8');
      callback();
    },
  });
  const logger = createLogger({
    service: 'test-service',
    level: 'info',
    output: stream,
    now: () => new Date('2026-08-16T12:00:00.000Z'),
  });

  logger.debug('hidden', 'not written');
  logger.info('test.event', 'written', { count: 2, size: 3n });

  const lines = output.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? ''), {
    timestamp: '2026-08-16T12:00:00.000Z',
    level: 'info',
    service: 'test-service',
    event: 'test.event',
    message: 'written',
    count: 2,
    size: '3',
  });
});
