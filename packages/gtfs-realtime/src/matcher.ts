import type { Pool } from 'pg';

import type {
  ResolvedMatch,
  StaticMatchIndex,
  StaticStop,
  StaticTripCandidate,
  TripDescriptor,
} from './types.js';
import { inferCandidateServiceDate, type ServiceDateAnchor } from './service-date.js';

interface StopHint {
  readonly stopSequence?: number | undefined;
  readonly stopId?: string | undefined;
  readonly arrivalTime?: number | undefined;
}

interface MatchTemporalContext {
  readonly fallbackInstantSeconds?: number | undefined;
}

const madridRoutePrefix = '10';

export function parseGtfsTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{1,2}):(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (hours > 99 || minutes > 59 || seconds > 59) return undefined;
  return hours * 3600 + minutes * 60 + seconds;
}

function normalizedDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /^\d{8}$/u.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : undefined;
}

function candidateMatchesHints(candidate: StaticTripCandidate, stops: readonly StopHint[]): boolean {
  return stops.every((hint) => {
    if (hint.stopSequence !== undefined) {
      const stop = candidate.stops.find((item) => item.stopSequence === hint.stopSequence);
      return stop !== undefined && (hint.stopId === undefined || stop.stopId === hint.stopId);
    }
    if (hint.stopId !== undefined) return candidate.stops.some((item) => item.stopId === hint.stopId);
    return true;
  });
}

function temporalDistance(
  candidate: StaticTripCandidate,
  descriptor: TripDescriptor,
  stops: readonly StopHint[],
  context: MatchTemporalContext,
): number | undefined {
  const date = normalizedDate(descriptor.startDate);
  if (date !== undefined) {
    return candidate.serviceDates === undefined || candidate.serviceDates.has(date) ? 0 : Number.POSITIVE_INFINITY;
  }
  if (candidate.serviceDates === undefined) return undefined;
  if (candidate.serviceDates.size === 0) return Number.POSITIVE_INFINITY;
  const anchors = stops.flatMap((hint): ServiceDateAnchor[] => {
    if (hint.arrivalTime === undefined) return [];
    const stop = resolveStop(candidate, hint).stop;
    return stop?.arrivalSeconds === undefined ? [] : [{
      instantSeconds: hint.arrivalTime,
      scheduledSeconds: stop.arrivalSeconds,
    }];
  });
  if (anchors.length === 0 && context.fallbackInstantSeconds === undefined) return undefined;
  return inferCandidateServiceDate(candidate, anchors, context.fallbackInstantSeconds)?.distanceSeconds ??
    Number.POSITIVE_INFINITY;
}

interface VersionMatch {
  readonly result: ResolvedMatch;
  readonly distance?: number | undefined;
}

function withinVersion(
  candidates: readonly StaticTripCandidate[],
  position: 'active' | 'previous',
  descriptor: TripDescriptor,
  stops: readonly StopHint[],
  context: MatchTemporalContext,
): VersionMatch | undefined {
  const versionCandidates = candidates.flatMap((candidate) => {
    if (candidate.versionPosition !== position) return [];
    const distance = temporalDistance(candidate, descriptor, stops, context);
    return distance === Number.POSITIVE_INFINITY ? [] : [{ candidate, distance }];
  });
  if (descriptor.tripId !== undefined) {
    const exact = versionCandidates.filter(({ candidate }) => candidate.tripId === descriptor.tripId);
    if (exact.length === 1) {
      return { result: { disposition: `${position}-exact-trip`, candidate: exact[0]!.candidate }, distance: exact[0]!.distance };
    }
    if (exact.length > 1) return { result: { disposition: 'ambiguous' } };
  }
  const startSeconds = parseGtfsTime(descriptor.startTime);
  if (descriptor.routeId === undefined || startSeconds === undefined) return undefined;
  const fallback = versionCandidates.filter(({ candidate }) =>
    candidate.routeId === descriptor.routeId && candidate.firstTimeSeconds === startSeconds &&
    candidateMatchesHints(candidate, stops));
  if (fallback.length === 1) {
    return { result: { disposition: `${position}-unique-fallback`, candidate: fallback[0]!.candidate },
      distance: fallback[0]!.distance };
  }
  if (fallback.length > 1) return { result: { disposition: 'ambiguous' } };
  return undefined;
}

export function matchTrip(
  index: StaticMatchIndex,
  descriptor: TripDescriptor,
  stops: readonly StopHint[] = [],
  context: MatchTemporalContext = {},
): ResolvedMatch {
  const active = withinVersion(index.candidates, 'active', descriptor, stops, context);
  if (active?.result.disposition === 'ambiguous') return active.result;
  const previous = withinVersion(index.candidates, 'previous', descriptor, stops, context);
  if (previous?.result.disposition === 'ambiguous' && active === undefined) return previous.result;
  if (active !== undefined && previous !== undefined && previous.distance !== undefined &&
      (active.distance === undefined || previous.distance < active.distance)) return previous.result;
  if (active !== undefined) return active.result;
  if (previous !== undefined) return previous.result;
  if (descriptor.routeId !== undefined && !descriptor.routeId.startsWith(madridRoutePrefix)) {
    return { disposition: 'non-madrid' };
  }
  if (descriptor.tripId !== undefined && index.knownNationalTripIds?.has(descriptor.tripId) === true) {
    return { disposition: 'non-madrid' };
  }
  return { disposition: 'unmatched' };
}

export function resolveStop(
  candidate: StaticTripCandidate,
  descriptor: StopHint,
): { readonly stop?: StaticStop; readonly ambiguous: boolean } {
  if (descriptor.stopSequence !== undefined) {
    const stop = candidate.stops.find((item) => item.stopSequence === descriptor.stopSequence);
    if (stop === undefined || (descriptor.stopId !== undefined && stop.stopId !== descriptor.stopId)) {
      return { ambiguous: false };
    }
    return { stop, ambiguous: false };
  }
  if (descriptor.stopId === undefined) return { ambiguous: false };
  const matches = candidate.stops.filter((item) => item.stopId === descriptor.stopId);
  return matches.length === 1 ? { stop: matches[0]!, ambiguous: false } : { ambiguous: matches.length > 1 };
}

interface CandidateRow {
  readonly feed_version_id: string;
  readonly version_position: 'active' | 'previous';
  readonly trip_id: string;
  readonly route_id: string;
  readonly service_id: string;
  readonly first_time_seconds: number | null;
  readonly line_id: string;
  readonly branch_id: string;
  readonly service_pattern_id: string;
  readonly shape_id: string | null;
  readonly stop_sequence: number;
  readonly stop_id: string;
  readonly station_id: string;
  readonly arrival_seconds: number | null;
  readonly start_date: string | null;
  readonly end_date: string | null;
  readonly monday: boolean;
  readonly tuesday: boolean;
  readonly wednesday: boolean;
  readonly thursday: boolean;
  readonly friday: boolean;
  readonly saturday: boolean;
  readonly sunday: boolean;
  readonly exceptions: Record<string, number> | null;
}

function serviceRuns(row: CandidateRow, date: string): boolean {
  const exception = row.exceptions?.[date];
  if (exception !== undefined) return exception === 1;
  if (row.start_date === null || row.end_date === null || date < row.start_date || date > row.end_date) return false;
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return [row.sunday, row.monday, row.tuesday, row.wednesday, row.thursday, row.friday, row.saturday][day] ?? false;
}

export async function loadStaticMatchIndex(
  pool: Pool,
  descriptors: readonly TripDescriptor[],
  alertRouteIds: readonly string[] = [],
  alertStopIds: readonly string[] = [],
  inferenceDates: readonly string[] = [],
): Promise<StaticMatchIndex> {
  const versionResult = await pool.query<{
    active_feed_version_id: string;
    previous_feed_version_id: string | null;
  }>(`
    SELECT id::text AS active_feed_version_id,
      previous_feed_version_id::text AS previous_feed_version_id
    FROM gtfs_static.current_feed_version
    WHERE network_slug = 'madrid'
  `);
  const version = versionResult.rows[0];
  if (version === undefined) throw new Error('No active Madrid static version is available');
  const versionIdentity = {
    activeFeedVersionId: version.active_feed_version_id,
    ...(version.previous_feed_version_id === null ? {} : {
      previousFeedVersionId: version.previous_feed_version_id,
    }),
  };
  const tripIds = [...new Set(descriptors.flatMap((descriptor) => descriptor.tripId === undefined ? [] : [descriptor.tripId]))];
  const routeIds = [...new Set(descriptors.flatMap((descriptor) => descriptor.routeId === undefined ? [] : [descriptor.routeId]))];
  const requestedDates = [...new Set([...inferenceDates, ...descriptors.flatMap((descriptor) => {
    const date = normalizedDate(descriptor.startDate);
    return date === undefined ? [] : [date];
  })])];
  const allRouteIds = [...new Set([...routeIds, ...alertRouteIds])];
  if (tripIds.length === 0 && allRouteIds.length === 0 && alertStopIds.length === 0) {
    return { candidates: [], versionIdentity };
  }
  const result = await pool.query<CandidateRow>(`
    WITH versions AS (
      SELECT current.id, 'active'::text AS version_position
      FROM gtfs_static.current_feed_version AS current
      WHERE current.network_slug = 'madrid'
      UNION ALL
      SELECT previous.id, 'previous'::text
      FROM gtfs_static.current_feed_version AS current
      JOIN gtfs_static.feed_version AS previous ON previous.id = current.previous_feed_version_id
      WHERE current.network_slug = 'madrid'
    )
    SELECT
      trip.feed_version_id::text, versions.version_position,
      trip.trip_id, trip.route_id, trip.service_id,
      COALESCE(first_stop.departure_seconds, first_stop.arrival_seconds) AS first_time_seconds,
      route_map.line_id::text, pattern_map.branch_id::text,
      pattern_map.service_pattern_id::text, trip.shape_id,
      stop_time.stop_sequence, stop_time.stop_id, stop_map.station_id::text,
      stop_time.arrival_seconds,
      service.start_date::text, service.end_date::text,
      service.monday, service.tuesday, service.wednesday, service.thursday,
      service.friday, service.saturday, service.sunday,
      COALESCE(exceptions.values, '{}'::jsonb) AS exceptions
    FROM versions
    JOIN gtfs_static.trip AS trip ON trip.feed_version_id = versions.id
    JOIN gtfs_static.trip_pattern_map AS pattern_map
      ON pattern_map.feed_version_id = trip.feed_version_id AND pattern_map.trip_id = trip.trip_id
    JOIN gtfs_static.route_line_map AS route_map
      ON route_map.feed_version_id = trip.feed_version_id AND route_map.route_id = trip.route_id
    JOIN gtfs_static.calendar_service AS service
      ON service.feed_version_id = trip.feed_version_id AND service.service_id = trip.service_id
    JOIN LATERAL (
      SELECT candidate.arrival_seconds, candidate.departure_seconds
      FROM gtfs_static.stop_time AS candidate
      WHERE candidate.feed_version_id = trip.feed_version_id AND candidate.trip_id = trip.trip_id
      ORDER BY candidate.stop_sequence
      LIMIT 1
    ) AS first_stop ON true
    JOIN gtfs_static.stop_time AS stop_time
      ON stop_time.feed_version_id = trip.feed_version_id AND stop_time.trip_id = trip.trip_id
    JOIN gtfs_static.stop_station_map AS stop_map
      ON stop_map.feed_version_id = stop_time.feed_version_id AND stop_map.stop_id = stop_time.stop_id
    LEFT JOIN LATERAL (
      SELECT jsonb_object_agg(exception.service_date::text, exception.exception_type) AS values
      FROM gtfs_static.calendar_exception AS exception
      WHERE exception.feed_version_id = trip.feed_version_id AND exception.service_id = trip.service_id
    ) AS exceptions ON true
    WHERE trip.trip_id = ANY($1::text[]) OR trip.route_id = ANY($2::text[])
    ORDER BY versions.version_position, trip.trip_id, stop_time.stop_sequence
  `, [tripIds, allRouteIds]);

  const targetResult = await pool.query<{
    kind: 'route' | 'stop'; source_id: string; feed_version_id: string; stable_id: string;
  }>(`
    WITH versions AS (
      SELECT current.id, 0 AS preference
      FROM gtfs_static.current_feed_version AS current WHERE current.network_slug = 'madrid'
      UNION ALL
      SELECT previous.id, 1
      FROM gtfs_static.current_feed_version AS current
      JOIN gtfs_static.feed_version AS previous ON previous.id = current.previous_feed_version_id
      WHERE current.network_slug = 'madrid'
    ), targets AS (
      SELECT 'route'::text AS kind, mapping.route_id AS source_id,
        mapping.feed_version_id::text, mapping.line_id::text AS stable_id, versions.preference
      FROM versions JOIN gtfs_static.route_line_map AS mapping ON mapping.feed_version_id = versions.id
      WHERE mapping.route_id = ANY($1::text[])
      UNION ALL
      SELECT 'stop', mapping.stop_id, mapping.feed_version_id::text,
        mapping.station_id::text, versions.preference
      FROM versions JOIN gtfs_static.stop_station_map AS mapping ON mapping.feed_version_id = versions.id
      WHERE mapping.stop_id = ANY($2::text[])
    )
    SELECT DISTINCT ON (kind, source_id) kind, source_id, feed_version_id, stable_id
    FROM targets ORDER BY kind, source_id, preference
  `, [alertRouteIds, alertStopIds]);

  const grouped = new Map<string, { row: CandidateRow; stops: StaticStop[] }>();
  for (const row of result.rows) {
    const key = `${row.feed_version_id}\0${row.trip_id}`;
    const entry = grouped.get(key) ?? { row, stops: [] };
    entry.stops.push({
      stopSequence: row.stop_sequence, stopId: row.stop_id, stationId: row.station_id,
      ...(row.arrival_seconds === null ? {} : { arrivalSeconds: row.arrival_seconds }),
    });
    grouped.set(key, entry);
  }
  const alertRoutes = new Map<string, { feedVersionId: string; lineId: string }>();
  const alertStops = new Map<string, { feedVersionId: string; stationId: string }>();
  for (const row of targetResult.rows) {
    if (row.kind === 'route') alertRoutes.set(row.source_id, { feedVersionId: row.feed_version_id, lineId: row.stable_id });
    else alertStops.set(row.source_id, { feedVersionId: row.feed_version_id, stationId: row.stable_id });
  }
  return {
    versionIdentity,
    candidates: [...grouped.values()].map(({ row, stops }) => ({
      feedVersionId: row.feed_version_id,
      versionPosition: row.version_position,
      tripId: row.trip_id,
      routeId: row.route_id,
      serviceId: row.service_id,
      ...(row.first_time_seconds === null ? {} : { firstTimeSeconds: row.first_time_seconds }),
      lineId: row.line_id,
      branchId: row.branch_id,
      servicePatternId: row.service_pattern_id,
      ...(row.shape_id === null ? {} : { shapeId: row.shape_id }),
      stops,
      ...(requestedDates.length === 0 ? {} : { serviceDates: new Set(requestedDates.filter((date) => serviceRuns(row, date))) }),
    })),
    alertRoutes,
    alertStops,
  };
}
