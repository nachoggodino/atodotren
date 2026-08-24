import type { Pool } from 'pg';

import { canonicalizeJourneys, closeJourneys } from '@atodotren/canonical-journeys';

import { aggregateDirty, finalizeAnalytics } from './analytics.js';

const MADRID_TIMEZONE = 'Europe/Madrid';

type MaintenanceEvent = (event: string, fields: Readonly<Record<string, unknown>>) => void;

export interface MaintenanceOptions {
  readonly pool: Pool;
  readonly intervalMs: number;
  readonly finalizeAfter: string;
  readonly finalizeBefore: string;
  readonly cycles?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onEvent?: MaintenanceEvent | undefined;
  readonly canonicalize?: typeof canonicalizeJourneys | undefined;
  readonly closeJourneys?: typeof closeJourneys | undefined;
  readonly aggregate?: typeof aggregateDirty | undefined;
  readonly finalize?: typeof finalizeAnalytics | undefined;
}

export interface MaintenanceReport {
  readonly cyclesAttempted: number;
  readonly operationFailures: number;
  readonly finalizationAttempts: number;
  readonly stoppedBySignal: boolean;
}

function madridClock(now: Date): { readonly date: string; readonly time: string } {
  const fields = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: MADRID_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    date: `${fields.year}-${fields.month}-${fields.day}`,
    time: `${fields.hour}:${fields.minute}`,
  };
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const completed = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', completed);
      resolve();
    };
    const timer = setTimeout(completed, milliseconds);
    signal?.addEventListener('abort', completed, { once: true });
  });
}

function errorClass(error: unknown): string {
  return error instanceof Error && error.name !== '' ? error.name : 'UnknownError';
}

export async function runMaintenance(options: MaintenanceOptions): Promise<MaintenanceReport> {
  const maximumCycles = options.cycles ?? Number.POSITIVE_INFINITY;
  const sleep = options.sleep ?? ((milliseconds) => delay(milliseconds, options.signal));
  const now = options.now ?? (() => new Date());
  let cyclesAttempted = 0;
  let operationFailures = 0;
  let finalizationAttempts = 0;
  let lastFinalizationDate: string | undefined;

  const attempt = async (kind: string, operation: () => Promise<unknown>): Promise<boolean> => {
    const started = performance.now();
    try {
      await operation();
      options.onEvent?.('maintenance.operation_completed', {
        kind, durationMs: Math.round(performance.now() - started),
      });
      return true;
    } catch (error) {
      operationFailures += 1;
      options.onEvent?.('maintenance.operation_failed', {
        kind, errorClass: errorClass(error), durationMs: Math.round(performance.now() - started),
      });
      return false;
    }
  };

  while (cyclesAttempted < maximumCycles && !(options.signal?.aborted ?? false)) {
    const cycleStarted = performance.now();
    cyclesAttempted += 1;
    await attempt('canonicalize', async () => {
      const report = await (options.canonicalize ?? canonicalizeJourneys)({ pool: options.pool, limit: 100 });
      if (Object.keys(report.errors).length > 0) throw new Error('Canonicalization reported bounded errors');
    });
    await attempt('close-journeys', async () => {
      const report = await (options.closeJourneys ?? closeJourneys)({ pool: options.pool, limit: 100 });
      if (Object.keys(report.errors).length > 0) throw new Error('Journey closure reported bounded errors');
    });
    await attempt('aggregate', async () => {
      const report = await (options.aggregate ?? aggregateDirty)({ pool: options.pool, limit: 20 });
      if (report.failed > 0) throw new Error('Aggregation reported bounded errors');
    });

    const current = now();
    const clock = madridClock(current);
    if (clock.time >= options.finalizeAfter && clock.time < options.finalizeBefore &&
        lastFinalizationDate !== clock.date) {
      finalizationAttempts += 1;
      const completed = await attempt('finalize', async () => {
        const report = await (options.finalize ?? finalizeAnalytics)({
          pool: options.pool, limit: 7, now: current, retentionMode: 'none',
        });
        if (report.errors.length > 0) throw new Error('Finalization reported bounded errors');
        if (report.serviceDays.some((item) => item.status !== 'verified' && item.status !== 'already_verified') ||
            report.months.some((item) => item.status !== 'sealed' && item.status !== 'already_sealed')) {
          throw new Error('Finalization did not verify every selected scope');
        }
      });
      if (completed) lastFinalizationDate = clock.date;
    }

    const remaining = options.intervalMs - Math.round(performance.now() - cycleStarted);
    if (cyclesAttempted < maximumCycles && remaining > 0 && !(options.signal?.aborted ?? false)) await sleep(remaining);
  }
  return {
    cyclesAttempted,
    operationFailures,
    finalizationAttempts,
    stoppedBySignal: options.signal?.aborted ?? false,
  };
}
