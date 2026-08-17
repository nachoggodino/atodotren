import type { Pool, PoolClient } from 'pg';

import type { NormalizedGtfsFeed } from './model.js';
import { slugify } from './normalize.js';
import { StaticImportError, type ActiveFeedMetadata } from './types.js';

const importLock = '7811417130112001';

export async function readActiveFeed(pool: Pool, networkSlug = 'madrid'): Promise<ActiveFeedMetadata | undefined> {
  const result = await pool.query<{
    id: string;
    source_url: string;
    sha256: string;
    etag: string | null;
    last_modified: string | null;
    activated_at: Date;
  }>(`
    SELECT version.id, version.source_url, version.sha256, version.etag, version.last_modified, version.activated_at
    FROM gtfs_static.feed_version AS version
    JOIN core.network AS network ON network.id = version.network_id
    WHERE network.slug = $1 AND version.status = 'active'
  `, [networkSlug]);
  const row = result.rows[0];
  return row === undefined ? undefined : {
    id: row.id,
    sourceUrl: row.source_url,
    sha256: row.sha256,
    etag: row.etag,
    lastModified: row.last_modified,
    activatedAt: row.activated_at,
  };
}

async function insertRows(
  client: PoolClient,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
  suffix = '',
): Promise<void> {
  const batchSize = Math.max(1, Math.floor(30_000 / columns.length));
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const tuples = batch.map((row) => {
      if (row.length !== columns.length) throw new Error(`Internal row width mismatch for ${table}`);
      const placeholders = row.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(',')})`;
    });
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ${suffix}`, values);
  }
}

export interface LoadResult {
  readonly kind: 'imported' | 'unchanged';
  readonly feedVersionId: string;
  readonly previousVersionId?: string;
}

export async function loadAndActivateFeed(options: {
  readonly pool: Pool;
  readonly sourceUrl: string;
  readonly checksum: string;
  readonly archiveBytes: number;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly feed: NormalizedGtfsFeed;
  readonly report: Readonly<Record<string, unknown>>;
}): Promise<LoadResult> {
  const client = await options.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '5min'");
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [importLock]);
    const networkResult = await client.query<{ id: string }>("SELECT id FROM core.network WHERE slug = 'madrid' AND is_active");
    const networkId = networkResult.rows[0]?.id;
    if (networkId === undefined) throw new StaticImportError('database', 'database.network.missing', 'Active Madrid network dimension is missing');

    const duplicate = await client.query<{ id: string; status: string }>(
      'SELECT id, status FROM gtfs_static.feed_version WHERE network_id = $1 AND sha256 = $2',
      [networkId, options.checksum],
    );
    const existing = duplicate.rows[0];
    if (existing !== undefined) {
      if (existing.status === 'active' || existing.status === 'superseded') {
        await client.query('ROLLBACK');
        return { kind: 'unchanged', feedVersionId: existing.id };
      }
      throw new StaticImportError('validation', 'feed.checksum.previously_rejected', 'This checksum already has a non-successful feed version', {
        feedVersionId: existing.id,
        status: existing.status,
      });
    }

    const insertedVersion = await client.query<{ id: string }>(`
      INSERT INTO gtfs_static.feed_version
        (network_id, source_url, sha256, etag, last_modified, archive_bytes, status,
         import_started_at, effective_from, effective_until)
      VALUES ($1, $2, $3, $4, $5, $6, 'downloaded', clock_timestamp(), $7, $8)
      RETURNING id
    `, [
      networkId,
      options.sourceUrl,
      options.checksum,
      options.etag ?? null,
      options.lastModified ?? null,
      options.archiveBytes,
      options.feed.effectiveFrom,
      options.feed.effectiveUntil,
    ]);
    const feedVersionId = insertedVersion.rows[0]?.id;
    if (feedVersionId === undefined) throw new Error('Feed version insert returned no identifier');
    await client.query("UPDATE gtfs_static.feed_version SET status = 'staged' WHERE id = $1", [feedVersionId]);

    const stationIds = new Map<string, string>();
    for (const station of options.feed.stations) {
      const result = await client.query<{ id: string }>(`
        INSERT INTO core.station
          (network_id, public_id, slug_es, slug_en, name_es, name_en, latitude, longitude)
        VALUES ($1, $2, $3, $3, $4, $4, $5, $6)
        ON CONFLICT (network_id, public_id) DO UPDATE SET
          name_es = EXCLUDED.name_es,
          name_en = EXCLUDED.name_en,
          latitude = COALESCE(EXCLUDED.latitude, core.station.latitude),
          longitude = COALESCE(EXCLUDED.longitude, core.station.longitude),
          is_active = true
        RETURNING id
      `, [networkId, station.publicId, station.slug, station.name, station.latitude, station.longitude]);
      const id = result.rows[0]?.id;
      if (id === undefined) throw new Error('Station upsert returned no identifier');
      stationIds.set(station.publicId, id);
    }

    const lineIds = new Map<string, string>();
    for (const line of options.feed.lines) {
      const result = await client.query<{ id: string }>(`
        INSERT INTO core.line
          (network_id, slug, public_code, name_es, name_en, color, text_color)
        VALUES ($1, $2, $3, $4, $4, $5, $6)
        ON CONFLICT (network_id, slug) DO UPDATE SET
          public_code = EXCLUDED.public_code,
          name_es = EXCLUDED.name_es,
          name_en = EXCLUDED.name_en,
          color = EXCLUDED.color,
          text_color = EXCLUDED.text_color,
          is_active = true
        RETURNING id
      `, [networkId, line.slug, line.publicCode, line.name, line.color, line.textColor]);
      const id = result.rows[0]?.id;
      if (id === undefined) throw new Error('Line upsert returned no identifier');
      lineIds.set(line.slug, id);
    }

    const branchIds = new Map<string, string>();
    for (const branch of options.feed.branches) {
      const lineId = lineIds.get(branch.lineSlug);
      const originId = stationIds.get(branch.originPublicId);
      const destinationId = stationIds.get(branch.destinationPublicId);
      if (lineId === undefined || originId === undefined || destinationId === undefined) throw new Error('Branch dimension references an unknown stable dimension');
      const result = await client.query<{ id: string }>(`
        INSERT INTO core.branch
          (line_id, slug, name_es, name_en, origin_station_id, destination_station_id)
        VALUES ($1, $2, $3, $3, $4, $5)
        ON CONFLICT (line_id, slug) DO UPDATE SET
          name_es = EXCLUDED.name_es,
          name_en = EXCLUDED.name_en,
          origin_station_id = EXCLUDED.origin_station_id,
          destination_station_id = EXCLUDED.destination_station_id,
          is_active = true
        RETURNING id
      `, [lineId, branch.slug, branch.name, originId, destinationId]);
      const id = result.rows[0]?.id;
      if (id === undefined) throw new Error('Branch upsert returned no identifier');
      branchIds.set(branch.key, id);
    }

    const patternIds = new Map<string, string>();
    for (const pattern of options.feed.patterns) {
      const branchId = branchIds.get(pattern.branchKey);
      if (branchId === undefined) throw new Error('Pattern references an unknown branch');
      const result = await client.query<{ id: string }>(`
        INSERT INTO core.service_pattern
          (branch_id, public_id, direction, pattern_hash, name_es, name_en)
        VALUES ($1, $2, $3, $4, $5, $5)
        ON CONFLICT (branch_id, direction, pattern_hash) DO UPDATE SET
          name_es = EXCLUDED.name_es,
          name_en = EXCLUDED.name_en,
          is_active = true
        RETURNING id
      `, [branchId, pattern.publicId, pattern.direction, pattern.hash, pattern.name]);
      const patternId = result.rows[0]?.id;
      if (patternId === undefined) throw new Error('Pattern upsert returned no identifier');
      patternIds.set(pattern.key, patternId);
      await insertRows(
        client,
        'core.service_pattern_stop',
        ['service_pattern_id', 'stop_order', 'station_id'],
        pattern.stationPublicIds.map((stationId, order) => {
          const id = stationIds.get(stationId);
          if (id === undefined) throw new Error('Pattern stop references an unknown station');
          return [patternId, order, id];
        }),
        'ON CONFLICT (service_pattern_id, stop_order) DO NOTHING',
      );
      await insertRows(
        client,
        'core.segment',
        ['service_pattern_id', 'segment_order', 'from_station_id', 'to_station_id'],
        pattern.stationPublicIds.slice(0, -1).map((stationId, order) => {
          const fromId = stationIds.get(stationId);
          const to = pattern.stationPublicIds[order + 1];
          const toId = to === undefined ? undefined : stationIds.get(to);
          if (fromId === undefined || toId === undefined) throw new Error('Segment references an unknown station');
          return [patternId, order, fromId, toId];
        }),
        'ON CONFLICT (service_pattern_id, segment_order) DO NOTHING',
      );
    }

    await insertRows(client, 'gtfs_static.stop', [
      'feed_version_id', 'stop_id', 'stop_code', 'stop_name', 'stop_desc', 'stop_lat', 'stop_lon',
      'location_type', 'parent_station', 'wheelchair_boarding', 'platform_code',
    ], options.feed.stops.map((stop) => [
      feedVersionId, stop.id, stop.code, stop.name, stop.description, stop.latitude, stop.longitude,
      stop.locationType, stop.parentStation, stop.wheelchairBoarding, stop.platformCode,
    ]));
    await insertRows(client, 'gtfs_static.route', [
      'feed_version_id', 'route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_desc',
      'route_type', 'route_url', 'route_color', 'route_text_color', 'route_sort_order',
    ], options.feed.routes.map((route) => [
      feedVersionId, route.id, route.agencyId, route.shortName, route.longName, route.description,
      route.type, route.url, route.color, route.textColor, route.sortOrder,
    ]));
    await insertRows(client, 'gtfs_static.calendar_service', [
      'feed_version_id', 'service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
      'saturday', 'sunday', 'start_date', 'end_date',
    ], options.feed.calendarServices.map((service) => [
      feedVersionId, service.id, ...service.weekdays, service.startDate, service.endDate,
    ]));
    await insertRows(client, 'gtfs_static.calendar_exception', [
      'feed_version_id', 'service_id', 'service_date', 'exception_type',
    ], options.feed.calendarExceptions.map((exception) => [feedVersionId, exception.serviceId, exception.date, exception.type]));
    await insertRows(client, 'gtfs_static.shape', ['feed_version_id', 'shape_id'], options.feed.shapeIds.map((id) => [feedVersionId, id]));
    await insertRows(client, 'gtfs_static.shape_point', [
      'feed_version_id', 'shape_id', 'point_sequence', 'latitude', 'longitude', 'distance_traveled',
    ], options.feed.shapePoints.map((point) => [feedVersionId, point.shapeId, point.sequence, point.latitude, point.longitude, point.distance]));
    await insertRows(client, 'gtfs_static.trip', [
      'feed_version_id', 'trip_id', 'route_id', 'service_id', 'trip_headsign', 'trip_short_name',
      'direction_id', 'block_id', 'shape_id', 'wheelchair_accessible', 'bikes_allowed',
    ], options.feed.trips.map((trip) => [
      feedVersionId, trip.id, trip.routeId, trip.serviceId, trip.headsign, trip.shortName,
      trip.directionId, trip.blockId, trip.shapeId, trip.wheelchairAccessible, trip.bikesAllowed,
    ]));
    await insertRows(client, 'gtfs_static.stop_time', [
      'feed_version_id', 'trip_id', 'stop_sequence', 'stop_id', 'arrival_seconds', 'departure_seconds',
      'stop_headsign', 'pickup_type', 'drop_off_type', 'shape_dist_traveled', 'timepoint',
    ], options.feed.stopTimes.map((item) => [
      feedVersionId, item.tripId, item.sequence, item.stopId, item.arrivalSeconds, item.departureSeconds,
      item.headsign, item.pickupType, item.dropOffType, item.shapeDistance, item.timepoint,
    ]));

    await insertRows(client, 'gtfs_static.stop_station_map', [
      'feed_version_id', 'stop_id', 'station_id', 'mapping_rule',
    ], options.feed.stops.map((stop) => {
      const stationId = stationIds.get(stop.stationPublicId);
      if (stationId === undefined) throw new Error('Stop mapping references an unknown station');
      return [feedVersionId, stop.id, stationId, stop.stationMappingRule];
    }));
    await insertRows(client, 'gtfs_static.route_line_map', [
      'feed_version_id', 'route_id', 'line_id', 'mapping_rule',
    ], options.feed.routes.map((route) => {
      const lineId = lineIds.get(slugify(route.shortName ?? route.longName ?? route.id));
      if (lineId === undefined) throw new Error('Route mapping references an unknown line');
      return [feedVersionId, route.id, lineId, route.mappingRule];
    }));
    await insertRows(client, 'gtfs_static.trip_pattern_map', [
      'feed_version_id', 'trip_id', 'branch_id', 'service_pattern_id', 'mapping_rule',
    ], options.feed.tripMappings.map((mapping) => {
      const branchId = branchIds.get(mapping.branchKey);
      const patternId = patternIds.get(mapping.patternKey);
      if (branchId === undefined || patternId === undefined) throw new Error('Trip mapping references an unknown stable dimension');
      return [feedVersionId, mapping.tripId, branchId, patternId, 'route-pattern-content-hash'];
    }));

    await client.query(`
      UPDATE gtfs_static.feed_version
      SET status = 'validated', validated_at = clock_timestamp(),
          validation_report = $2::jsonb, import_report = $3::jsonb
      WHERE id = $1
    `, [feedVersionId, JSON.stringify({ ok: true, warnings: options.feed.warnings }), JSON.stringify(options.report)]);
    const active = await client.query<{ id: string }>(
      "SELECT id FROM gtfs_static.feed_version WHERE network_id = $1 AND status = 'active' FOR UPDATE",
      [networkId],
    );
    const previousVersionId = active.rows[0]?.id;
    if (previousVersionId !== undefined) {
      await client.query("UPDATE gtfs_static.feed_version SET status = 'superseded' WHERE id = $1", [previousVersionId]);
    }
    await client.query(`
      UPDATE gtfs_static.feed_version
      SET status = 'active', activated_at = clock_timestamp(), previous_feed_version_id = $2
      WHERE id = $1
    `, [feedVersionId, previousVersionId ?? null]);
    await client.query('COMMIT');

    await options.pool.query('SELECT gtfs_static.analyze_static_tables()');
    return {
      kind: 'imported',
      feedVersionId,
      ...(previousVersionId === undefined ? {} : { previousVersionId }),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof StaticImportError) throw error;
    throw new StaticImportError('database', 'database.import.failed', 'Static feed database import failed', {}, { cause: error });
  } finally {
    client.release();
  }
}

export async function recordRejectedVersion(options: {
  readonly pool: Pool;
  readonly sourceUrl: string;
  readonly checksum: string;
  readonly archiveBytes: number;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly code: string;
  readonly message: string;
  readonly report: Readonly<Record<string, unknown>>;
}): Promise<string | undefined> {
  const client = await options.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [importLock]);
    const existing = await client.query<{ id: string }>(`
      SELECT version.id
      FROM gtfs_static.feed_version AS version
      JOIN core.network AS network ON network.id = version.network_id
      WHERE network.slug = 'madrid' AND version.sha256 = $1
    `, [options.checksum]);
    if (existing.rows[0] !== undefined) {
      await client.query('ROLLBACK');
      return existing.rows[0].id;
    }
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO gtfs_static.feed_version
        (network_id, source_url, sha256, etag, last_modified, archive_bytes, status,
         import_started_at, rejected_at, validation_report, import_report, rejection_code, rejection_message)
      SELECT id, $1, $2, $3, $4, $5, 'rejected', clock_timestamp(), clock_timestamp(),
        $6::jsonb, $7::jsonb, $8, $9
      FROM core.network WHERE slug = 'madrid'
      RETURNING id
    `, [
      options.sourceUrl,
      options.checksum,
      options.etag ?? null,
      options.lastModified ?? null,
      options.archiveBytes,
      JSON.stringify({ ok: false, code: options.code }),
      JSON.stringify(options.report),
      options.code.slice(0, 128),
      options.message.slice(0, 1024),
    ]);
    await client.query('COMMIT');
    return inserted.rows[0]?.id;
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);
    return undefined;
  } finally {
    client.release();
  }
}
