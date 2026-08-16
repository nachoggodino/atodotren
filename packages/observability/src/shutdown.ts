import type { Logger } from './logger.js';

export type ShutdownTask = () => Promise<void> | void;

export interface ShutdownManager {
  readonly signal: AbortSignal;
  register(name: string, task: ShutdownTask): void;
  shutdown(reason: string): Promise<void>;
  dispose(): void;
}

interface ShutdownOptions {
  readonly logger: Logger;
  readonly timeoutMs: number;
}

export function createShutdownManager(options: ShutdownOptions): ShutdownManager {
  const controller = new AbortController();
  const tasks: Array<readonly [string, ShutdownTask]> = [];
  let shutdownPromise: Promise<void> | undefined;

  const run = async (reason: string): Promise<void> => {
    options.logger.info('shutdown.started', 'Graceful shutdown started', { reason });
    controller.abort(reason);

    const cleanup = async (): Promise<void> => {
      for (const [name, task] of [...tasks].reverse()) {
        options.logger.debug('shutdown.task.started', 'Shutdown task started', { name });
        await task();
        options.logger.debug('shutdown.task.completed', 'Shutdown task completed', { name });
      }
    };

    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Graceful shutdown exceeded ${options.timeoutMs}ms`));
      }, options.timeoutMs);
      timeout.unref();
    });

    try {
      await Promise.race([cleanup(), deadline]);
      options.logger.info('shutdown.completed', 'Graceful shutdown completed', { reason });
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (shutdownPromise !== undefined) {
      options.logger.error('shutdown.forced', 'Second signal forced immediate shutdown', { signal });
      process.exit(1);
    }
    process.exitCode = 128 + (signal === 'SIGINT' ? 2 : 15);
    shutdownPromise = run(signal).catch((error: unknown) => {
      options.logger.error('shutdown.failed', 'Graceful shutdown failed', { error });
      process.exitCode = 1;
    });
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return {
    signal: controller.signal,
    register: (name, task) => {
      tasks.push([name, task]);
    },
    shutdown: (reason) => {
      shutdownPromise ??= run(reason);
      return shutdownPromise;
    },
    dispose: () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}
