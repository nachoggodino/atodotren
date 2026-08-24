import type { Pool } from 'pg';

import { acquireFeed, FeedAcquisitionError, type FeedEndpoint } from './acquisition.js';
import { emitHeartbeat, IncidentTracker, PostgresIncidentStore, type AlertTransport } from './alerts.js';
import { decodeFeed, FeedDecodeError } from './decoder.js';
import { loadStaticMatchIndex } from './matcher.js';
import { checksum, inferenceServiceDates, normalizeFeed } from './normalize.js';
import { persistBatch, updateIngestHealth } from './persistence.js';
import { replaySpool } from './spool.js';
import type { OutageSpool } from './spool.js';
import type {
  NormalizedBatch,
  PollRecord,
  StaticMatchIndex,
  TripDescriptor,
} from './types.js';

export interface IngestRuntimeConfig {
  readonly endpoints: readonly FeedEndpoint[];
  readonly requestTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly cycleIntervalMs: number;
  readonly alertIntervalMs: number;
  readonly heartbeatUrl?: string;
  readonly failureThreshold: number;
  readonly matchingRateMinimum: number;
  readonly matchingRateRecoveryMinimum: number;
  readonly matchingRecoveryThreshold: number;
  readonly malformedRateMaximum: number;
  readonly spoolWarningRatio: number;
  readonly staleAfterMs: number;
}

export interface IngestRunOptions {
  readonly pool: Pool;
  readonly spool: OutageSpool;
  readonly config: IngestRuntimeConfig;
  readonly cycles?: number;
  readonly signal?: AbortSignal;
  readonly transports?: readonly AlertTransport[];
  readonly fetchImplementation?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => Date;
  readonly onEvent?: (event: string, fields: Readonly<Record<string, unknown>>) => void;
  readonly loadStaticIndex?: typeof loadStaticMatchIndex;
  readonly afterCycle?: () => Promise<void>;
}

export interface IngestRunReport {
  readonly cyclesAttempted: number;
  readonly successfulCycles: number;
  readonly postgresPersistedFeeds: number;
  readonly spooledFeeds: number;
  readonly replayedFeeds: number;
  readonly evidenceInserted: number;
  readonly evidenceRepeated: number;
  readonly matchedMadrid: number;
  readonly nonMadrid: number;
  readonly unmatched: number;
  readonly invalid: number;
  readonly responseBytes: number;
  readonly stoppedBySignal: boolean;
}

class StaticIndexUnavailableError extends Error {
  public constructor(options?: ErrorOptions) {
    super('Initial Madrid static matching index is unavailable', options);
    this.name = 'StaticIndexUnavailableError';
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function mergeStaticMatchIndex(previous: StaticMatchIndex | undefined, current: StaticMatchIndex): StaticMatchIndex {
  if (previous?.versionIdentity !== undefined && current.versionIdentity !== undefined && (
    previous.versionIdentity.activeFeedVersionId !== current.versionIdentity.activeFeedVersionId ||
    previous.versionIdentity.previousFeedVersionId !== current.versionIdentity.previousFeedVersionId
  )) return current;
  const candidates = new Map<string, StaticMatchIndex['candidates'][number]>();
  for (const candidate of [...(previous?.candidates ?? []), ...current.candidates]) {
    candidates.set(`${candidate.feedVersionId}\0${candidate.tripId}`, candidate);
  }
  return {
    ...(current.versionIdentity === undefined ? {} : { versionIdentity: current.versionIdentity }),
    candidates: [...candidates.values()],
    alertRoutes: new Map([...(previous?.alertRoutes ?? []), ...(current.alertRoutes ?? [])]),
    alertStops: new Map([...(previous?.alertStops ?? []), ...(current.alertStops ?? [])]),
  };
}

function descriptorsForFeed(feed: ReturnType<typeof decodeFeed>): {
  descriptors: TripDescriptor[]; routes: string[]; stops: string[];
} {
  const descriptors: TripDescriptor[] = [];
  const routes: string[] = [];
  const stops: string[] = [];
  for (const entity of feed.entities) {
    if (entity.kind === 'trip_update' || entity.kind === 'vehicle_position') descriptors.push(entity.trip);
    else {
      for (const target of entity.targets) {
        if (target.trip !== undefined) descriptors.push(target.trip);
        if (target.routeId !== undefined) routes.push(target.routeId);
        if (target.stopId !== undefined) stops.push(target.stopId);
      }
    }
  }
  return { descriptors, routes, stops };
}

function pollRecord(input: Omit<PollRecord, 'idempotencyKey'>): PollRecord {
  return { ...input, idempotencyKey: checksum(input) };
}

async function durablePersist(
  pool: Pool,
  spool: OutageSpool,
  poll: PollRecord,
  batch: NormalizedBatch | undefined,
): Promise<{ durable: boolean; postgres: boolean; evidenceInserted: number; evidenceRepeated: number }> {
  try {
    const result = await persistBatch(pool, poll, batch);
    return { durable: true, postgres: true, evidenceInserted: result.evidenceInserted, evidenceRepeated: result.evidenceRepeated };
  } catch {
    const queued = spool.enqueue({ poll, ...(batch === undefined ? {} : { batch }) });
    return { durable: queued.stored, postgres: false, evidenceInserted: 0, evidenceRepeated: 0 };
  }
}

export async function runIngest(options: IngestRunOptions): Promise<IngestRunReport> {
  const sleep = options.sleep ?? delay;
  const now = options.now ?? (() => new Date());
  const transports = options.transports ?? [];
  const incidents = new IncidentTracker({
    store: new PostgresIncidentStore(options.pool), transports, now,
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  });
  const loadStaticIndex = options.loadStaticIndex ?? loadStaticMatchIndex;
  const maximumCycles = options.cycles ?? Number.POSITIVE_INFINITY;
  let lastAlertPoll = 0;
  let staticCache: StaticMatchIndex | undefined;
  let consecutiveFailures = 0;
  let previousDropped = options.spool.stats().droppedCount;
  let lastSuccessfulCycleMs = now().getTime();
  let lastHeartbeatMs = lastSuccessfulCycleMs;
  const report = {
    cyclesAttempted: 0, successfulCycles: 0, postgresPersistedFeeds: 0, spooledFeeds: 0,
    replayedFeeds: 0, evidenceInserted: 0, evidenceRepeated: 0, matchedMadrid: 0,
    nonMadrid: 0, unmatched: 0, invalid: 0, responseBytes: 0, stoppedBySignal: false,
  };

  while (report.cyclesAttempted < maximumCycles && !(options.signal?.aborted ?? false)) {
    const cycleStarted = performance.now();
    const cycleAt = now();
    report.cyclesAttempted += 1;
    let cycleSuccessful = true;
    let replayFailed = false;
    try {
      const replay = await replaySpool(options.spool, options.pool);
      report.replayedFeeds += replay.replayed;
    } catch {
      replayFailed = true;
    }
    const endpoints = options.config.endpoints.filter((endpoint) => {
      if (!endpoint.enabled) return false;
      if (endpoint.kind !== 'service_alerts') return true;
      if (cycleAt.getTime() - lastAlertPoll >= options.config.alertIntervalMs) {
        lastAlertPoll = cycleAt.getTime();
        return true;
      }
      return false;
    });
    let cycleMatched = 0;
    let cycleMatchable = 0;
    let cycleInvalid = 0;
    let cycleEntities = 0;
    let staticMismatch = false;
    let heartbeatAt: string | undefined;
    for (const endpoint of endpoints) {
      if (options.signal?.aborted ?? false) {
        report.stoppedBySignal = true;
        cycleSuccessful = false;
        break;
      }
      const startedAt = now();
      const feedStarted = performance.now();
      let staticIndexDurationMs = 0;
      let matchingNormalizationDurationMs = 0;
      let poll: PollRecord;
      let batch: NormalizedBatch | undefined;
      let acquired: Awaited<ReturnType<typeof acquireFeed>> | undefined;
      try {
        acquired = await acquireFeed(endpoint, {
          timeoutMs: options.config.requestTimeoutMs,
          maxResponseBytes: options.config.maxResponseBytes,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.fetchImplementation === undefined ? {} : { fetchImplementation: options.fetchImplementation }),
          sleep,
        });
        report.responseBytes += acquired.responseBytes;
        const capturedAt = now();
        const feed = decodeFeed(acquired.body, endpoint.kind);
        const identities = descriptorsForFeed(feed);
        const staticIndexStarted = performance.now();
        try {
          const loaded = await loadStaticIndex(
            options.pool,
            identities.descriptors,
            identities.routes,
            identities.stops,
            inferenceServiceDates(capturedAt),
          );
          staticCache = mergeStaticMatchIndex(staticCache, loaded);
        } catch (error) {
          if (staticCache === undefined) {
            staticMismatch = true;
            throw new StaticIndexUnavailableError({ cause: error });
          }
        }
        staticIndexDurationMs = Math.round(performance.now() - staticIndexStarted);
        const matchingStarted = performance.now();
        batch = normalizeFeed(feed, capturedAt, staticCache ?? { candidates: [] });
        matchingNormalizationDurationMs = Math.round(performance.now() - matchingStarted);
        cycleMatched += batch.matchedMadridCount;
        cycleMatchable += batch.matchedMadridCount + batch.unmatchedCount;
        cycleInvalid += batch.invalidCount;
        cycleEntities += feed.entityTotal;
        report.matchedMadrid += batch.matchedMadridCount;
        report.nonMadrid += batch.nonMadridCount;
        report.unmatched += batch.unmatchedCount;
        report.invalid += batch.invalidCount;
        poll = pollRecord({
          feedKind: endpoint.kind, startedAt: startedAt.toISOString(), completedAt: now().toISOString(),
          capturedAt: capturedAt.toISOString(), feedHeaderTimestamp: feed.headerTimestamp,
          httpStatus: acquired.status, resultClass: 'success', responseBytes: acquired.responseBytes,
          entityTotal: feed.entityTotal, matchedMadridCount: batch.matchedMadridCount,
          nonMadridCount: batch.nonMadridCount, unmatchedCount: batch.unmatchedCount,
          invalidCount: batch.invalidCount, responseDurationMs: acquired.durationMs,
          persistenceDurationMs: 0,
        });
      } catch (error) {
        cycleSuccessful = false;
        const completedAt = now();
        const acquisition = error instanceof FeedAcquisitionError ? error : undefined;
        const decoding = error instanceof FeedDecodeError ? error : undefined;
        const staticUnavailable = error instanceof StaticIndexUnavailableError;
        poll = pollRecord({
          feedKind: endpoint.kind, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(),
          capturedAt: completedAt.toISOString(),
          ...(acquisition?.status === undefined && acquired?.status === undefined ? {} : {
            httpStatus: acquisition?.status ?? acquired?.status,
          }),
          resultClass: staticUnavailable ? 'persistence_error' : acquisition?.code ?? decoding?.code ?? 'network_error',
          responseBytes: acquired?.responseBytes ?? 0,
          entityTotal: 0, matchedMadridCount: 0, nonMadridCount: 0, unmatchedCount: 0,
          invalidCount: 0, responseDurationMs: acquisition?.durationMs ?? acquired?.durationMs ?? Math.round(performance.now() - cycleStarted),
          persistenceDurationMs: 0,
          errorCode: staticUnavailable ? 'static.index_unavailable' : acquisition?.code ?? decoding?.code ?? 'poll.unexpected',
        });
      }
      const persistenceStarted = performance.now();
      const durable = await durablePersist(options.pool, options.spool, poll, batch);
      const persistenceDurationMs = Math.round(performance.now() - persistenceStarted);
      if (!durable.durable) cycleSuccessful = false;
      if (durable.postgres) report.postgresPersistedFeeds += 1;
      else if (durable.durable) report.spooledFeeds += 1;
      report.evidenceInserted += durable.evidenceInserted;
      report.evidenceRepeated += durable.evidenceRepeated;
      options.onEvent?.('ingest.poll', {
        feedKind: poll.feedKind, resultClass: poll.resultClass, durable: durable.durable,
        postgres: durable.postgres, matchedMadrid: poll.matchedMadridCount,
        unmatched: poll.unmatchedCount, nonMadrid: poll.nonMadridCount, invalid: poll.invalidCount,
        unresolvedServiceDates: batch?.operations.filter((operation) =>
          operation.kind === 'stop_evidence' && operation.serviceDate === undefined).length ?? 0,
        responseBytes: poll.responseBytes, responseDurationMs: poll.responseDurationMs,
        acquisitionDurationMs: poll.responseDurationMs,
        staticIndexDurationMs,
        matchingNormalizationDurationMs,
        persistenceDurationMs,
        totalFeedDurationMs: Math.round(performance.now() - feedStarted),
        candidateCacheSize: staticCache?.candidates.length ?? 0,
      });
    }

    if (!(options.signal?.aborted ?? false) && options.afterCycle !== undefined) {
      try {
        await options.afterCycle();
      } catch {
        cycleSuccessful = false;
        options.onEvent?.('canonical.maintenance_failed', {});
      }
    }

    if (cycleSuccessful && endpoints.length > 0) {
      report.successfulCycles += 1;
      consecutiveFailures = 0;
      lastSuccessfulCycleMs = now().getTime();
      if (options.config.heartbeatUrl !== undefined) {
        try {
          await emitHeartbeat(options.config.heartbeatUrl, options.fetchImplementation);
          heartbeatAt = now().toISOString();
          lastHeartbeatMs = now().getTime();
          await incidents.observe({
            incidentKey: 'heartbeat.failure', active: false,
            threshold: options.config.failureThreshold,
            title: 'Heartbeat delivery failed',
            body: 'External heartbeat delivery succeeded again.',
          });
        } catch {
          await incidents.observe({
            incidentKey: 'heartbeat.failure', active: true,
            threshold: options.config.failureThreshold,
            title: 'Heartbeat delivery failed',
            body: 'Ingestion persisted durably but the external heartbeat failed.',
          });
        }
      }
    } else {
      consecutiveFailures += 1;
    }
    const matchingRate = cycleMatchable === 0 ? 1 : cycleMatched / cycleMatchable;
    const malformedRate = cycleEntities === 0 ? 0 : cycleInvalid / cycleEntities;
    const spoolStats = options.spool.stats();
    const shed = spoolStats.droppedCount > previousDropped;
    previousDropped = spoolStats.droppedCount;
    await Promise.all([
      incidents.observe({
        incidentKey: 'ingest.repeated_failure', active: !cycleSuccessful,
        threshold: options.config.failureThreshold, title: 'Repeated ingestion failure',
        body: `${consecutiveFailures} consecutive cycle(s) have failed.`,
      }),
      incidents.observe({
        incidentKey: 'ingest.matching_collapse',
        active: matchingRate < options.config.matchingRateMinimum,
        recoveryObserved: matchingRate > options.config.matchingRateRecoveryMinimum,
        recoveryThreshold: options.config.matchingRecoveryThreshold,
        threshold: options.config.failureThreshold, title: 'Madrid matching rate collapsed',
        body: `Current matching rate: ${matchingRate.toFixed(3)}.`,
      }),
      incidents.observe({
        incidentKey: 'ingest.malformed_spike', active: malformedRate > options.config.malformedRateMaximum,
        threshold: options.config.failureThreshold, title: 'Malformed realtime entity spike',
        body: `Current malformed rate: ${malformedRate.toFixed(3)}.`,
      }),
      incidents.observe({
        incidentKey: 'spool.growth', active: spoolStats.sizeBytes / options.spool.capacityBytes > options.config.spoolWarningRatio,
        threshold: options.config.failureThreshold, title: 'SQLite spool growth',
        body: `Current spool size: ${spoolStats.sizeBytes} bytes.`,
      }),
      incidents.observe({
        incidentKey: 'spool.shedding', active: shed, threshold: 1,
        title: 'SQLite spool shed operations', body: `Dropped operation count: ${spoolStats.droppedCount}.`,
      }),
      incidents.observe({
        incidentKey: 'spool.replay_failure', active: replayFailed,
        threshold: options.config.failureThreshold, title: 'SQLite replay failure',
        body: 'Ordered PostgreSQL replay did not complete.',
      }),
      incidents.observe({
        incidentKey: 'static.version_mismatch', active: staticMismatch,
        threshold: options.config.failureThreshold, title: 'Realtime/static version mismatch',
        body: 'No usable active/previous static matching index was available.',
      }),
      incidents.observe({
        incidentKey: 'ingest.stale', active: now().getTime() - lastSuccessfulCycleMs > options.config.staleAfterMs,
        threshold: options.config.failureThreshold, title: 'Successful ingestion is stale',
        body: `No successful durable cycle within ${options.config.staleAfterMs}ms.`,
      }),
      incidents.observe({
        incidentKey: 'heartbeat.stale',
        active: options.config.heartbeatUrl !== undefined && now().getTime() - lastHeartbeatMs > options.config.staleAfterMs,
        threshold: options.config.failureThreshold, title: 'External heartbeat is stale',
        body: `No successful heartbeat within ${options.config.staleAfterMs}ms.`,
      }),
    ]);
    try {
      const durableAt = cycleSuccessful ? now().toISOString() : undefined;
      await updateIngestHealth(options.pool, {
        ...(durableAt === undefined ? {} : { durableAt }),
        ...(durableAt !== undefined && spoolStats.pendingCount === 0 ? { postgresAt: durableAt } : {}),
        ...(heartbeatAt === undefined ? {} : { heartbeatAt }),
        consecutiveFailures,
        ...(cycleSuccessful ? {} : { failureCode: 'cycle.failed' }),
        spoolPendingCount: spoolStats.pendingCount, spoolBytes: spoolStats.sizeBytes,
        spoolDroppedCount: spoolStats.droppedCount,
      });
    } catch {
      // PostgreSQL health state catches up after replay; SQLite remains authoritative during an outage.
    }
    const remaining = options.config.cycleIntervalMs - Math.round(performance.now() - cycleStarted);
    if (report.cyclesAttempted < maximumCycles && remaining > 0 && !(options.signal?.aborted ?? false)) {
      await sleep(remaining);
    }
  }
  if (options.signal?.aborted ?? false) report.stoppedBySignal = true;
  return report;
}

export async function runReplay(pool: Pool, spool: OutageSpool): Promise<{
  readonly replayed: number; readonly pending: number;
}> {
  const result = await replaySpool(spool, pool);
  return { replayed: result.replayed, pending: spool.stats().pendingCount };
}
