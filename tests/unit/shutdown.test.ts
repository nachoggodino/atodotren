import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import test from 'node:test';

import { createLogger, createShutdownManager } from '@atodotren/observability';

function logger() {
  return createLogger({ service: 'test', level: 'debug', output: new Writable({ write(_c, _e, cb) { cb(); } }) });
}

void test('shutdown is LIFO, attempts every task, aggregates failures, and is repeatable', async () => {
  const order: string[] = [];
  const manager = createShutdownManager({ logger: logger(), timeoutMs: 1_000 });
  await manager.register('first', () => { order.push('first'); });
  await manager.register('throws', () => { order.push('throws'); throw new Error('failure'); });
  await manager.register('last', () => { order.push('last'); });
  const first = manager.shutdown('test');
  const second = manager.shutdown('ignored');
  assert.equal(first, second);
  await assert.rejects(first, AggregateError);
  assert.deepEqual(order, ['last', 'throws', 'first']);
  manager.dispose();
});

void test('late registration and shutdown during asynchronous initialization cannot leak', async () => {
  const manager = createShutdownManager({ logger: logger(), timeoutMs: 1_000 });
  let closed = false;
  let finishInitialization: (() => void) | undefined;
  const initialization = new Promise<void>((resolve) => { finishInitialization = resolve; });
  const acquired = initialization.then(() => () => { closed = true; });
  await manager.shutdown('initialization-signal');
  finishInitialization?.();
  await manager.register('late-pool', await acquired);
  assert.equal(closed, true);
  manager.dispose();
});

void test('shutdown timeout is bounded and observable', async () => {
  const manager = createShutdownManager({ logger: logger(), timeoutMs: 20 });
  await manager.register('hung', () => new Promise(() => undefined));
  await assert.rejects(manager.shutdown('timeout'), /exceeded 20ms/u);
  manager.dispose();
});

void test('signals request graceful shutdown and a second signal forces termination deliberately', async () => {
  const signals = new EventEmitter();
  const exitCodes: number[] = [];
  const forced: number[] = [];
  const manager = createShutdownManager({
    logger: logger(), timeoutMs: 1_000, signalTarget: signals,
    setExitCode: (code) => exitCodes.push(code), forceExit: (code) => forced.push(code),
  });
  signals.emit('SIGTERM', 'SIGTERM');
  signals.emit('SIGINT', 'SIGINT');
  await manager.shutdown('same');
  assert.deepEqual(exitCodes, [143]);
  assert.deepEqual(forced, [1]);
  assert.equal(manager.signal.aborted, true);
  manager.dispose();
});
