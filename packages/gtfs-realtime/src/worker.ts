import type { Pool } from 'pg';

import { acquireFeed, FeedAcquisitionError, type FeedEndpoint } from './acquisition.js';
import { emitHeartbeat, sendOperationalAlert, type AlertTransport } from './alerts.js';
import { decodeFeed, FeedDecodeError } from './decoder.js';
import { loadStaticMatchIndex } from './matcher.js';
import { checksum, normalizeFeed } from './normalize.js';
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

class LocalIncidentTracker {
  readonly #state = new Map<string, { count: number; notified: boolean }>();
  readonly #transports: readonly AlertTransport[];
  readonly #pool: Pool;

  public constructor(transports: readonly AlertTransport[], pool: Pool) {
    this.#transports = transports;
    this.#pool = pool;
  }

  public async observe(key: string, active: boolean, threshold: number, title: string, body: string): Promise<void> {
    const previous = this.#state.get(key);
    const stored = await this.#pool.query<{
      is_open: boolean;
      last_notified_at: Date | null;
      occurrence_count: number;
    }>(`
      SELECT is_open, last_notified_at, occurrence_count
      FROM operations.notification_incident
      WHERE incident_key = $1
    `, [key]).then((result) => result.rows[0]).catch(() => undefined);
    if (!active) {
      if (previous?.notified === true || (stored?.is_open === true && stored.last_notified_at !== null)) {
        await sendOperationalAlert(this.#transports, {
          incidentKey: key, title: `${title} recovered`, body, recovery: true,
        });
      }
      this.#state.delete(key);
      await this.#pool.query(`
        UPDATE operations.notification_incident SET
          is_open = false, recovered_at = clock_timestamp(), last_observed_at = clock_timestamp()
        WHERE incident_key = $1 AND is_open
      `, [key]).catch(() => undefined);
      return;
    }
    const current = {
      count: (previous?.count ?? (stored?.is_open === true ? stored.occurrence_count : 0)) + 1,
      notified: previous?.notified ?? (stored?.is_open === true && stored.last_notified_at !== null),
    };
    let newlyNotified = false;
    if (current.count >= threshold && !current.notified) {
      await sendOperationalAlert(this.#transports, { incidentKey: key, title, body, recovery: false });
      current.notified = true;
      newlyNotified = true;
    }
    this.#state.set(key, current);
    await this.#pool.query(`
      INSERT INTO operations.notification_incident (
        incident_key, opened_at, last_observed_at, last_notified_at,
        occurrence_count, is_open, details
      ) VALUES ($1, clock_timestamp(), clock_timestamp(), $2, $3, true, $4::jsonb)
      ON CONFLICT (incident_key) DO UPDATE SET
        opened_at = CASE WHEN operations.notification_incident.is_open
          THEN operations.notification_incident.opened_at ELSE clock_timestamp() END,
        last_observed_at = clock_timestamp(),
        last_notified_at = COALESCE(EXCLUDED.last_notified_at, operations.notification_incident.last_notified_at),
        occurrence_count = EXCLUDED.occurrence_count,
        is_open = true, recovered_at = NULL, details = EXCLUDED.details
    `, [key, newlyNotified ? new Date() : null, current.count, JSON.stringify({ title, body })])
      .catch(() => undefined);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mergeIndex(previous: StaticMatchIndex | undefined, current: StaticMatchIndex): StaticMatchIndex {
  const candidates = new Map<string, StaticMatchIndex['candidates'][number]>();
  for (const candidate of [...(previous?.candidates ?? []), ...current.candidates]) {
    candidates.set(`${candidate.feedVersionId}\0${candidate.tripId}`, candidate);
  }
  return {
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
  const incidents = new LocalIncidentTracker(transports, options.pool);
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
      let poll: PollRecord;
      let batch: NormalizedBatch | undefined;
      try {
        const acquired = await acquireFeed(endpoint, {
          timeoutMs: options.config.requestTimeoutMs,
          maxResponseBytes: options.config.maxResponseBytes,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.fetchImplementation === undefined ? {} : { fetchImplementation: options.fetchImplementation }),
          sleep,
        });
        const capturedAt = now();
        const feed = decodeFeed(acquired.body, endpoint.kind);
        const identities = descriptorsForFeed(feed);
        try {
          const loaded = await loadStaticMatchIndex(options.pool, identities.descriptors, identities.routes, identities.stops);
          staticCache = mergeIndex(staticCache, loaded);
        } catch {
          if (staticCache === undefined) staticMismatch = true;
        }
        batch = normalizeFeed(feed, capturedAt, staticCache ?? { candidates: [] });
        cycleMatched += batch.matchedMadridCount;
        cycleMatchable += batch.matchedMadridCount + batch.unmatchedCount;
        cycleInvalid += batch.invalidCount;
        cycleEntities += feed.entityTotal;
        report.matchedMadrid += batch.matchedMadridCount;
        report.nonMadrid += batch.nonMadridCount;
        report.unmatched += batch.unmatchedCount;
        report.invalid += batch.invalidCount;
        report.responseBytes += acquired.responseBytes;
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
        poll = pollRecord({
          feedKind: endpoint.kind, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(),
          capturedAt: completedAt.toISOString(),
          ...(acquisition?.status === undefined ? {} : { httpStatus: acquisition.status }),
          resultClass: acquisition?.code ?? decoding?.code ?? 'network_error', responseBytes: 0,
          entityTotal: 0, matchedMadridCount: 0, nonMadridCount: 0, unmatchedCount: 0,
          invalidCount: 0, responseDurationMs: acquisition?.durationMs ?? Math.round(performance.now() - cycleStarted),
          persistenceDurationMs: 0, errorCode: acquisition?.code ?? decoding?.code ?? 'poll.unexpected',
        });
      }
      const durable = await durablePersist(options.pool, options.spool, poll, batch);
      if (!durable.durable) cycleSuccessful = false;
      if (durable.postgres) report.postgresPersistedFeeds += 1;
      else if (durable.durable) report.spooledFeeds += 1;
      report.evidenceInserted += durable.evidenceInserted;
      report.evidenceRepeated += durable.evidenceRepeated;
      options.onEvent?.('ingest.poll', {
        feedKind: poll.feedKind, resultClass: poll.resultClass, durable: durable.durable,
        postgres: durable.postgres, matchedMadrid: poll.matchedMadridCount,
        unmatched: poll.unmatchedCount, nonMadrid: poll.nonMadridCount, invalid: poll.invalidCount,
        responseBytes: poll.responseBytes, responseDurationMs: poll.responseDurationMs,
      });
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
        } catch {
          await incidents.observe('heartbeat.failure', true, options.config.failureThreshold,
            'Heartbeat delivery failed', 'Ingestion persisted durably but the external heartbeat failed.');
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
      incidents.observe('ingest.repeated_failure', !cycleSuccessful, options.config.failureThreshold,
        'Repeated ingestion failure', `${consecutiveFailures} consecutive cycle(s) have failed.`),
      incidents.observe('ingest.matching_collapse', matchingRate < options.config.matchingRateMinimum,
        options.config.failureThreshold, 'Madrid matching rate collapsed', `Current matching rate: ${matchingRate.toFixed(3)}.`),
      incidents.observe('ingest.malformed_spike', malformedRate > options.config.malformedRateMaximum,
        options.config.failureThreshold, 'Malformed realtime entity spike', `Current malformed rate: ${malformedRate.toFixed(3)}.`),
      incidents.observe('spool.growth', spoolStats.sizeBytes / options.spool.capacityBytes > options.config.spoolWarningRatio,
        options.config.failureThreshold, 'SQLite spool growth', `Current spool size: ${spoolStats.sizeBytes} bytes.`),
      incidents.observe('spool.shedding', shed, 1, 'SQLite spool shed operations',
        `Dropped operation count: ${spoolStats.droppedCount}.`),
      incidents.observe('spool.replay_failure', replayFailed, options.config.failureThreshold,
        'SQLite replay failure', 'Ordered PostgreSQL replay did not complete.'),
      incidents.observe('static.version_mismatch', staticMismatch, options.config.failureThreshold,
        'Realtime/static version mismatch', 'No usable active/previous static matching index was available.'),
      incidents.observe('ingest.stale', now().getTime() - lastSuccessfulCycleMs > options.config.staleAfterMs,
        options.config.failureThreshold, 'Successful ingestion is stale',
        `No successful durable cycle within ${options.config.staleAfterMs}ms.`),
      incidents.observe('heartbeat.stale', options.config.heartbeatUrl !== undefined && now().getTime() - lastHeartbeatMs > options.config.staleAfterMs,
        options.config.failureThreshold, 'External heartbeat is stale',
        `No successful heartbeat within ${options.config.staleAfterMs}ms.`),
    ]).catch(() => undefined);
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
