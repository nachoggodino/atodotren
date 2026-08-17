import type { Logger } from './logger.js';

export type ShutdownTask = () => Promise<void> | void;

export interface ShutdownManager {
  readonly signal: AbortSignal;
  register(name: string, task: ShutdownTask): Promise<void>;
  shutdown(reason: string): Promise<void>;
  dispose(): void;
}

interface SignalTarget {
  on(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

export interface ShutdownOptions {
  readonly logger: Logger;
  readonly timeoutMs: number;
  readonly signalTarget?: SignalTarget;
  readonly setExitCode?: (code: number) => void;
  readonly forceExit?: (code: number) => void;
}

export function createShutdownManager(options: ShutdownOptions): ShutdownManager {
  const controller = new AbortController();
  const tasks: Array<readonly [string, ShutdownTask]> = [];
  const signalTarget = options.signalTarget ?? process;
  const setExitCode = options.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));
  let state: 'open' | 'shutting-down' | 'finished' = 'open';
  let shutdownPromise: Promise<void> | undefined;

  const executeTask = async (name: string, task: ShutdownTask): Promise<void> => {
    options.logger.debug('shutdown.task.started', 'Shutdown task started', { name });
    await task();
    options.logger.debug('shutdown.task.completed', 'Shutdown task completed', { name });
  };

  const run = async (reason: string): Promise<void> => {
    state = 'shutting-down';
    options.logger.info('shutdown.started', 'Graceful shutdown started', { reason });
    controller.abort(reason);
    const failures: unknown[] = [];

    const cleanup = async (): Promise<void> => {
      let task = tasks.pop();
      while (task !== undefined) {
        const [name, cleanupTask] = task;
        try {
          await executeTask(name, cleanupTask);
        } catch (error) {
          failures.push(error);
          options.logger.error('shutdown.task.failed', 'Shutdown task failed', { name, error });
        }
        task = tasks.pop();
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} shutdown task(s) failed`);
      }
    };

    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(`Graceful shutdown exceeded ${options.timeoutMs}ms`);
        options.logger.error('shutdown.timeout', 'Graceful shutdown timed out', {
          timeoutMs: options.timeoutMs,
        });
        reject(error);
      }, options.timeoutMs);
      timeout.unref();
    });

    try {
      await Promise.race([cleanup(), deadline]);
      options.logger.info('shutdown.completed', 'Graceful shutdown completed', { reason });
    } finally {
      state = 'finished';
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  };

  const shutdown = (reason: string): Promise<void> => {
    shutdownPromise ??= run(reason);
    return shutdownPromise;
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (shutdownPromise !== undefined) {
      options.logger.error('shutdown.forced', 'Second signal forced immediate shutdown', { signal });
      forceExit(1);
      return;
    }
    setExitCode(signal === 'SIGINT' ? 130 : 143);
    void shutdown(signal).catch((error: unknown) => {
      options.logger.error('shutdown.failed', 'Graceful shutdown failed', { error });
      setExitCode(1);
    });
  };

  signalTarget.on('SIGINT', onSignal);
  signalTarget.on('SIGTERM', onSignal);

  return {
    signal: controller.signal,
    register: (name, task) => {
      if (state === 'open') {
        tasks.push([name, task]);
        return Promise.resolve();
      }
      return executeTask(name, task);
    },
    shutdown,
    dispose: () => {
      signalTarget.off('SIGINT', onSignal);
      signalTarget.off('SIGTERM', onSignal);
    },
  };
}
