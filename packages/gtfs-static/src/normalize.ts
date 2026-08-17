import { createHash } from 'node:crypto';

import { readCsvRecords } from './csv.js';
import type {
  CalendarException,
  CalendarService,
  GtfsRoute,
  GtfsStop,
  GtfsStopTime,
  GtfsTrip,
  NormalizedGtfsFeed,
  ShapePoint,
  StableBranch,
  StableLine,
  StablePattern,
  StableStation,
  TripMapping,
} from './model.js';
import { parseGtfsTime } from './time.js';
import { StaticImportError, type EntityCounts, type MadridMappingConfig, type StaticImportLimits } from './types.js';

const emptyCounts = (): Record<keyof EntityCounts, number> => ({
  routes: 0,
  trips: 0,
  stops: 0,
  stopTimes: 0,
  calendarServices: 0,
  calendarExceptions: 0,
  shapes: 0,
  shapePoints: 0,
});

function optional(value: string | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized === '' ? null : normalized;
}

function required(row: Readonly<Record<string, string>>, field: string, file: string): string {
  const value = row[field]?.trim() ?? '';
  if (value === '') {
    throw new StaticImportError('validation', 'gtfs.field.required', `${file}: ${field} must not be empty`, { file, field });
  }
  return value;
}

function integer(value: string | undefined, field: string, file: string, allowed?: readonly number[]): number | null {
  const normalized = optional(value);
  if (normalized === null) return null;
  if (!/^-?\d+$/u.test(normalized)) {
    throw new StaticImportError('validation', 'gtfs.integer.invalid', `${file}: ${field} must be an integer`, { file, field });
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || (allowed !== undefined && !allowed.includes(parsed))) {
    throw new StaticImportError('validation', 'gtfs.integer.invalid', `${file}: ${field} has an unsupported value`, { file, field });
  }
  return parsed;
}

function decimal(value: string | undefined, field: string, file: string): number | null {
  const normalized = optional(value);
  if (normalized === null) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new StaticImportError('validation', 'gtfs.decimal.invalid', `${file}: ${field} must be finite`, { file, field });
  }
  return parsed;
}

function decimalInRange(
  value: string | undefined,
  field: string,
  file: string,
  minimum: number,
  maximum: number,
  requiredValue = false,
): number | null {
  const parsed = decimal(value, field, file);
  if ((requiredValue && parsed === null) || (parsed !== null && (parsed < minimum || parsed > maximum))) {
    throw new StaticImportError('validation', 'gtfs.decimal.range', `${file}: ${field} is outside its valid range`, { file, field, minimum, maximum });
  }
  return parsed;
}

function date(value: string, field: string, file: string): string {
  if (!/^\d{8}$/u.test(value)) {
    throw new StaticImportError('validation', 'gtfs.date.invalid', `${file}: ${field} must use YYYYMMDD`, { file, field });
  }
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new StaticImportError('validation', 'gtfs.date.invalid', `${file}: ${field} is not a calendar date`, { file, field });
  }
  return iso;
}

export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (slug === '') {
    throw new StaticImportError('validation', 'mapping.slug.empty', 'A stable public slug could not be derived');
  }
  return slug.slice(0, 120);
}

export function hashServicePattern(stationPublicIds: readonly string[]): string {
  const hash = createHash('sha256');
  for (const id of stationPublicIds) hash.update(id).update('\0');
  return hash.digest('hex');
}

function routeRule(row: Readonly<Record<string, string>>, mapping: MadridMappingConfig): string | null {
  const id = row.route_id?.trim() ?? '';
  const matches = mapping.routeRules.filter(
    (rule) => rule.routeIdPrefixes.some((prefix) => id.startsWith(prefix)),
  );
  if (matches.length > 1) {
    throw new StaticImportError('validation', 'mapping.route.ambiguous', 'A route matches multiple Madrid mapping rules', {
      routeId: id.slice(0, 128),
      rules: matches.map((rule) => rule.id),
    });
  }
  return matches[0]?.id ?? null;
}

function checkUnique(set: Set<string>, key: string, entity: string): void {
  if (set.has(key)) {
    throw new StaticImportError('validation', `gtfs.${entity}.duplicate`, `Duplicate ${entity} source identifier`, {
      entity,
      identifier: key.slice(0, 128),
    });
  }
  set.add(key);
}

export async function normalizeMadridGtfs(
  files: ReadonlyMap<string, string>,
  mapping: MadridMappingConfig,
  limits: StaticImportLimits,
): Promise<NormalizedGtfsFeed> {
  const parsed = emptyCounts();
  const warnings: string[] = [];
  const agencyPath = files.get('agency.txt');
  if (agencyPath === undefined) throw new StaticImportError('validation', 'gtfs.agency.missing', 'agency.txt is required for explicit RENFE source identity validation');
  const agencyIds = new Set<string>();
  for await (const row of readCsvRecords(agencyPath, {
    file: 'agency.txt',
    required: ['agency_id', 'agency_name', 'agency_url', 'agency_timezone'],
    optional: ['agency_lang', 'agency_phone', 'agency_fare_url', 'agency_email'],
  }, limits.maxRowBytes)) {
    agencyIds.add(required(row, 'agency_id', 'agency.txt'));
  }
  if (agencyIds.size !== mapping.sourceAgencyIds.length
    || mapping.sourceAgencyIds.some((agencyId) => !agencyIds.has(agencyId))) {
    throw new StaticImportError('validation', 'mapping.agency.unexpected', 'The source agency identity does not match the configured RENFE feed', {
      expected: mapping.sourceAgencyIds,
      actual: [...agencyIds].slice(0, 16),
    });
  }
  const routes: GtfsRoute[] = [];
  const routeIds = new Set<string>();
  const allRouteIds = new Set<string>();
  const routePath = files.get('routes.txt');
  if (routePath === undefined) throw new Error('routes.txt was not extracted');
  for await (const row of readCsvRecords(routePath, {
    file: 'routes.txt',
    required: ['route_id', 'route_short_name', 'route_long_name', 'route_type'],
    optional: ['agency_id', 'route_desc', 'route_url', 'route_color', 'route_text_color', 'route_sort_order'],
  }, limits.maxRowBytes)) {
    parsed.routes += 1;
    const id = required(row, 'route_id', 'routes.txt');
    checkUnique(allRouteIds, id, 'route');
    const rule = routeRule(row, mapping);
    if (rule === null) continue;
    const shortName = optional(row.route_short_name);
    const longName = optional(row.route_long_name);
    if (shortName === null && longName === null) {
      throw new StaticImportError('validation', 'gtfs.route.name_missing', 'Retained route has no usable name', { routeId: id.slice(0, 128) });
    }
    routeIds.add(id);
    const routeType = integer(row.route_type, 'route_type', 'routes.txt');
    if (routeType === null || routeType < 0) throw new StaticImportError('validation', 'gtfs.route_type.invalid', 'routes.txt: route_type must be non-negative');
    const sortOrder = integer(row.route_sort_order, 'route_sort_order', 'routes.txt');
    if (sortOrder !== null && sortOrder < 0) throw new StaticImportError('validation', 'gtfs.route_sort_order.invalid', 'routes.txt: route_sort_order must be non-negative');
    routes.push({
      id,
      agencyId: optional(row.agency_id),
      shortName,
      longName,
      description: optional(row.route_desc),
      type: routeType,
      url: optional(row.route_url),
      color: optional(row.route_color),
      textColor: optional(row.route_text_color),
      sortOrder,
      mappingRule: rule,
    });
  }
  if (routes.length === 0) {
    throw new StaticImportError('validation', 'mapping.routes.empty', 'No routes matched the explicit Madrid source mapping');
  }

  let trips: GtfsTrip[] = [];
  const tripIds = new Set<string>();
  const allTripIds = new Set<string>();
  const serviceIds = new Set<string>();
  const referencedShapeIds = new Set<string>();
  const tripPath = files.get('trips.txt');
  if (tripPath === undefined) throw new Error('trips.txt was not extracted');
  for await (const row of readCsvRecords(tripPath, {
    file: 'trips.txt',
    required: ['route_id', 'service_id', 'trip_id'],
    optional: ['trip_headsign', 'trip_short_name', 'direction_id', 'block_id', 'shape_id', 'wheelchair_accessible', 'bikes_allowed'],
  }, limits.maxRowBytes)) {
    parsed.trips += 1;
    const id = required(row, 'trip_id', 'trips.txt');
    checkUnique(allTripIds, id, 'trip');
    const routeId = required(row, 'route_id', 'trips.txt');
    if (!routeIds.has(routeId)) continue;
    const serviceId = required(row, 'service_id', 'trips.txt');
    const direction = integer(row.direction_id, 'direction_id', 'trips.txt', [0, 1]);
    const shapeId = optional(row.shape_id);
    tripIds.add(id);
    trips.push({
      id,
      routeId,
      serviceId,
      headsign: optional(row.trip_headsign),
      shortName: optional(row.trip_short_name),
      directionId: direction as 0 | 1 | null,
      blockId: optional(row.block_id),
      shapeId,
      wheelchairAccessible: integer(row.wheelchair_accessible, 'wheelchair_accessible', 'trips.txt', [0, 1, 2]),
      bikesAllowed: integer(row.bikes_allowed, 'bikes_allowed', 'trips.txt', [0, 1, 2]),
    });
  }
  if (trips.length < mapping.canaries.minimumTrips) {
    throw new StaticImportError('validation', 'canary.trips.minimum', 'Madrid trip count is below the configured canary', {
      actual: trips.length,
      minimum: mapping.canaries.minimumTrips,
    });
  }

  let stopTimes: GtfsStopTime[] = [];
  const stopIds = new Set<string>();
  const sequences = new Map<string, Set<number>>();
  const stopTimesPath = files.get('stop_times.txt');
  if (stopTimesPath === undefined) throw new Error('stop_times.txt was not extracted');
  for await (const row of readCsvRecords(stopTimesPath, {
    file: 'stop_times.txt',
    required: ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'],
    optional: ['stop_headsign', 'pickup_type', 'drop_off_type', 'shape_dist_traveled', 'timepoint'],
  }, limits.maxRowBytes)) {
    parsed.stopTimes += 1;
    const tripId = required(row, 'trip_id', 'stop_times.txt');
    if (!tripIds.has(tripId)) continue;
    if (stopTimes.length >= limits.maxRetainedStopTimes) {
      throw new StaticImportError('validation', 'stop_times.retained.limit', 'Retained Madrid stop times exceed the configured memory bound', {
        limit: limits.maxRetainedStopTimes,
      });
    }
    const sequence = integer(row.stop_sequence, 'stop_sequence', 'stop_times.txt');
    if (sequence === null || sequence < 0) {
      throw new StaticImportError('validation', 'stop_times.sequence.invalid', 'stop_sequence must be a non-negative integer');
    }
    const tripSequences = sequences.get(tripId) ?? new Set<number>();
    if (tripSequences.has(sequence)) {
      throw new StaticImportError('validation', 'stop_times.sequence.duplicate', 'A retained trip contains a duplicate stop_sequence', { tripId: tripId.slice(0, 128), sequence });
    }
    tripSequences.add(sequence);
    sequences.set(tripId, tripSequences);
    const stopId = required(row, 'stop_id', 'stop_times.txt');
    stopIds.add(stopId);
    const arrivalSeconds = parseGtfsTime(row.arrival_time ?? '', 'stop_times.txt arrival_time');
    const departureSeconds = parseGtfsTime(row.departure_time ?? '', 'stop_times.txt departure_time');
    if (arrivalSeconds !== null && departureSeconds !== null && departureSeconds < arrivalSeconds) {
      throw new StaticImportError('validation', 'stop_times.departure.before_arrival', 'A retained departure time is earlier than its arrival time', { tripId: tripId.slice(0, 128), sequence });
    }
    const shapeDistance = decimal(row.shape_dist_traveled, 'shape_dist_traveled', 'stop_times.txt');
    if (shapeDistance !== null && shapeDistance < 0) throw new StaticImportError('validation', 'stop_times.shape_distance.invalid', 'shape_dist_traveled must be non-negative');
    stopTimes.push({
      tripId,
      sequence,
      stopId,
      arrivalSeconds,
      departureSeconds,
      headsign: optional(row.stop_headsign),
      pickupType: integer(row.pickup_type, 'pickup_type', 'stop_times.txt', [0, 1, 2, 3]),
      dropOffType: integer(row.drop_off_type, 'drop_off_type', 'stop_times.txt', [0, 1, 2, 3]),
      shapeDistance,
      timepoint: integer(row.timepoint, 'timepoint', 'stop_times.txt', [0, 1]),
    });
  }
  const incompleteTrips = trips.filter((trip) => (sequences.get(trip.id)?.size ?? 0) < 2);
  if (incompleteTrips.length > 0) {
    const incompleteIds = new Set(incompleteTrips.map((trip) => trip.id));
    const withoutStops = incompleteTrips.filter((trip) => !sequences.has(trip.id)).length;
    trips = trips.filter((trip) => !incompleteIds.has(trip.id));
    stopTimes = stopTimes.filter((item) => !incompleteIds.has(item.tripId));
    for (const id of incompleteIds) tripIds.delete(id);
    stopIds.clear();
    for (const item of stopTimes) stopIds.add(item.stopId);
    warnings.push(
      `Discarded ${incompleteTrips.length} Madrid trip records that cannot form a service pattern: ${withoutStops} without stop times and ${incompleteTrips.length - withoutStops} with one stop`,
    );
  }
  if (trips.length < mapping.canaries.minimumTrips) {
    throw new StaticImportError('validation', 'canary.trips.minimum', 'Madrid trip count is below the configured canary after incomplete trips were discarded', {
      actual: trips.length,
      minimum: mapping.canaries.minimumTrips,
    });
  }
  for (const trip of trips) {
    serviceIds.add(trip.serviceId);
    if (trip.shapeId !== null) referencedShapeIds.add(trip.shapeId);
  }
  stopTimes.sort((left, right) => left.tripId.localeCompare(right.tripId) || left.sequence - right.sequence);

  const stops: GtfsStop[] = [];
  const seenStopIds = new Set<string>();
  const stationKeys = new Map<string, string>();
  const stopsPath = files.get('stops.txt');
  if (stopsPath === undefined) throw new Error('stops.txt was not extracted');
  for await (const row of readCsvRecords(stopsPath, {
    file: 'stops.txt',
    required: ['stop_id', 'stop_name'],
    optional: ['stop_code', 'stop_desc', 'stop_lat', 'stop_lon', 'location_type', 'parent_station', 'wheelchair_boarding', 'platform_code'],
  }, limits.maxRowBytes)) {
    parsed.stops += 1;
    const id = required(row, 'stop_id', 'stops.txt');
    checkUnique(seenStopIds, id, 'stop');
    if (!stopIds.has(id)) continue;
    const alias = mapping.stationAliases[id];
    const code = optional(row.stop_code);
    const stationPublicId = slugify(alias ?? code ?? id);
    const prior = stationKeys.get(stationPublicId);
    if (prior !== undefined && prior !== id) {
      throw new StaticImportError('validation', 'mapping.station.ambiguous', 'Multiple retained stops map to the same stable station key', {
        stationPublicId,
        stopIds: [prior.slice(0, 128), id.slice(0, 128)],
      });
    }
    stationKeys.set(stationPublicId, id);
    const latitude = decimalInRange(row.stop_lat, 'stop_lat', 'stops.txt', -90, 90);
    const longitude = decimalInRange(row.stop_lon, 'stop_lon', 'stops.txt', -180, 180);
    if ((latitude === null) !== (longitude === null)) {
      throw new StaticImportError('validation', 'gtfs.stop.coordinates.partial', 'A retained stop must provide both latitude and longitude or neither', { stopId: id.slice(0, 128) });
    }
    stops.push({
      id,
      code,
      name: required(row, 'stop_name', 'stops.txt'),
      description: optional(row.stop_desc),
      latitude,
      longitude,
      locationType: integer(row.location_type, 'location_type', 'stops.txt', [0, 1, 2, 3, 4]),
      parentStation: optional(row.parent_station),
      wheelchairBoarding: integer(row.wheelchair_boarding, 'wheelchair_boarding', 'stops.txt', [0, 1, 2]),
      platformCode: optional(row.platform_code),
      stationPublicId,
      stationMappingRule: alias !== undefined
        ? 'configured-station-alias'
        : code !== null
          ? 'renfe-stop-code'
          : 'renfe-stop-id-explicit-fallback',
    });
  }
  const missingStops = [...stopIds].filter((id) => !seenStopIds.has(id));
  if (missingStops.length > 0) {
    throw new StaticImportError('validation', 'gtfs.stop.reference_missing', 'Retained stop_times reference missing stops', { count: missingStops.length, sample: missingStops.slice(0, 5) });
  }
  if (stops.length < mapping.canaries.minimumStations) {
    throw new StaticImportError('validation', 'canary.stations.minimum', 'Madrid station count is below the configured canary', { actual: stops.length, minimum: mapping.canaries.minimumStations });
  }

  const calendarServices = new Map<string, CalendarService>();
  const calendarPath = files.get('calendar.txt');
  if (calendarPath !== undefined) {
    const seen = new Set<string>();
    for await (const row of readCsvRecords(calendarPath, {
      file: 'calendar.txt',
      required: ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
    }, limits.maxRowBytes)) {
      parsed.calendarServices += 1;
      const id = required(row, 'service_id', 'calendar.txt');
      checkUnique(seen, id, 'calendar_service');
      if (!serviceIds.has(id)) continue;
      const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(
        (field) => integer(row[field], field, 'calendar.txt', [0, 1]) === 1,
      ) as unknown as CalendarService['weekdays'];
      calendarServices.set(id, {
        id,
        weekdays,
        startDate: date(required(row, 'start_date', 'calendar.txt'), 'start_date', 'calendar.txt'),
        endDate: date(required(row, 'end_date', 'calendar.txt'), 'end_date', 'calendar.txt'),
      });
    }
  }

  const calendarExceptions: CalendarException[] = [];
  const exceptionServices = new Set<string>();
  const calendarDatesPath = files.get('calendar_dates.txt');
  if (calendarDatesPath !== undefined) {
    const seen = new Set<string>();
    for await (const row of readCsvRecords(calendarDatesPath, {
      file: 'calendar_dates.txt',
      required: ['service_id', 'date', 'exception_type'],
    }, limits.maxRowBytes)) {
      parsed.calendarExceptions += 1;
      const serviceId = required(row, 'service_id', 'calendar_dates.txt');
      const serviceDate = date(required(row, 'date', 'calendar_dates.txt'), 'date', 'calendar_dates.txt');
      checkUnique(seen, `${serviceId}\0${serviceDate}`, 'calendar_exception');
      if (!serviceIds.has(serviceId)) continue;
      const type = integer(row.exception_type, 'exception_type', 'calendar_dates.txt', [1, 2]) as 1 | 2;
      calendarExceptions.push({ serviceId, date: serviceDate, type });
      exceptionServices.add(serviceId);
    }
  }
  for (const id of serviceIds) {
    if (!calendarServices.has(id) && exceptionServices.has(id)) {
      calendarServices.set(id, { id, weekdays: [false, false, false, false, false, false, false], startDate: null, endDate: null });
    }
    const service = calendarServices.get(id);
    if (service === undefined || (!service.weekdays.some(Boolean) && !calendarExceptions.some((item) => item.serviceId === id && item.type === 1))) {
      throw new StaticImportError('validation', 'calendar.service.unusable', 'A retained trip references a service with no usable operating day', { serviceId: id.slice(0, 128) });
    }
  }

  const shapePoints: ShapePoint[] = [];
  const retainedShapeIds = new Set<string>();
  const allShapeIds = new Set<string>();
  const shapeSequences = new Set<string>();
  const shapePath = files.get('shapes.txt');
  if (shapePath !== undefined) {
    for await (const row of readCsvRecords(shapePath, {
      file: 'shapes.txt',
      required: ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'],
      optional: ['shape_dist_traveled'],
    }, limits.maxRowBytes)) {
      parsed.shapePoints += 1;
      const shapeId = required(row, 'shape_id', 'shapes.txt');
      allShapeIds.add(shapeId);
      if (!referencedShapeIds.has(shapeId)) continue;
      const sequence = integer(row.shape_pt_sequence, 'shape_pt_sequence', 'shapes.txt');
      if (sequence === null || sequence < 0) throw new StaticImportError('validation', 'shape.sequence.invalid', 'shape_pt_sequence must be non-negative');
      checkUnique(shapeSequences, `${shapeId}\0${sequence}`, 'shape_point');
      retainedShapeIds.add(shapeId);
      const distance = decimal(row.shape_dist_traveled, 'shape_dist_traveled', 'shapes.txt');
      if (distance !== null && distance < 0) throw new StaticImportError('validation', 'shape.distance.invalid', 'shape_dist_traveled must be non-negative');
      shapePoints.push({
        shapeId,
        sequence,
        latitude: decimalInRange(row.shape_pt_lat, 'shape_pt_lat', 'shapes.txt', -90, 90, true) ?? 0,
        longitude: decimalInRange(row.shape_pt_lon, 'shape_pt_lon', 'shapes.txt', -180, 180, true) ?? 0,
        distance,
      });
    }
  }
  parsed.shapes = allShapeIds.size;
  const missingShapes = [...referencedShapeIds].filter((id) => !retainedShapeIds.has(id));
  if (missingShapes.length > 0) {
    throw new StaticImportError('validation', 'shape.reference_missing', 'Retained trips reference missing or empty shapes', { count: missingShapes.length, sample: missingShapes.slice(0, 5) });
  }
  if (mapping.canaries.requireReferencedShapes && referencedShapeIds.size === 0) {
    throw new StaticImportError('validation', 'canary.shapes.missing', 'Configured canary requires Madrid trips with referenced shapes');
  }
  shapePoints.sort((left, right) => left.shapeId.localeCompare(right.shapeId) || left.sequence - right.sequence);

  const stations: StableStation[] = stops.map((stop) => ({
    publicId: stop.stationPublicId,
    slug: stop.stationPublicId,
    name: stop.name,
    latitude: stop.latitude,
    longitude: stop.longitude,
  }));
  const stopToStation = new Map(stops.map((stop) => [stop.id, stop.stationPublicId]));
  const linesBySlug = new Map<string, StableLine>();
  for (const route of routes) {
    const code = route.shortName ?? route.longName ?? route.id;
    const slug = slugify(code);
    const existing = linesBySlug.get(slug);
    if (existing !== undefined && existing.publicCode !== code) {
      throw new StaticImportError('validation', 'mapping.line.ambiguous', 'Two retained routes produce the same line slug with different labels', { slug });
    }
    linesBySlug.set(slug, { slug, publicCode: code, name: route.longName ?? code, color: route.color, textColor: route.textColor });
  }
  for (const requiredLine of mapping.canaries.requiredLineCodes) {
    if (![...linesBySlug.values()].some((line) => line.publicCode === requiredLine)) {
      throw new StaticImportError('validation', 'canary.line.missing', 'A configured Madrid line canary is absent', { line: requiredLine });
    }
  }
  for (const requiredStation of mapping.canaries.requiredStationPublicIds) {
    if (!stations.some((station) => station.publicId === requiredStation)) {
      throw new StaticImportError('validation', 'canary.station.missing', 'A configured Madrid station canary is absent', { station: requiredStation });
    }
  }

  const timesByTrip = new Map<string, GtfsStopTime[]>();
  for (const item of stopTimes) {
    const list = timesByTrip.get(item.tripId) ?? [];
    list.push(item);
    timesByTrip.set(item.tripId, list);
  }
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const branchesByKey = new Map<string, StableBranch>();
  const patternsByKey = new Map<string, StablePattern>();
  const tripMappings: TripMapping[] = [];
  let collapsedAdjacentStationCalls = 0;
  for (const trip of [...trips].sort((left, right) => left.id.localeCompare(right.id))) {
    const ordered = timesByTrip.get(trip.id) ?? [];
    const mappedStationPublicIds = ordered.map((item) => stopToStation.get(item.stopId)).filter((item): item is string => item !== undefined);
    if (mappedStationPublicIds.length !== ordered.length) throw new StaticImportError('validation', 'mapping.pattern.stop_missing', 'Service pattern contains an unmapped stop');
    const stationPublicIds = mappedStationPublicIds.filter((stationId, index) => index === 0 || stationId !== mappedStationPublicIds[index - 1]);
    collapsedAdjacentStationCalls += mappedStationPublicIds.length - stationPublicIds.length;
    const first = stationPublicIds[0];
    const last = stationPublicIds.at(-1);
    if (first === undefined || last === undefined || first === last) {
      throw new StaticImportError('validation', 'mapping.pattern.endpoints', 'Service pattern endpoints must be distinct');
    }
    const route = routeById.get(trip.routeId);
    if (route === undefined) throw new Error('Retained trip route disappeared');
    const lineSlug = slugify(route.shortName ?? route.longName ?? route.id);
    const endpoints = [first, last].sort();
    const branchKey = `${lineSlug}\0${endpoints[0]}\0${endpoints[1]}`;
    if (!branchesByKey.has(branchKey)) {
      branchesByKey.set(branchKey, {
        key: branchKey,
        slug: slugify(`${lineSlug}-${endpoints[0]}-${endpoints[1]}`),
        lineSlug,
        name: `${route.shortName ?? route.longName}: ${first}–${last}`,
        originPublicId: endpoints[0] ?? first,
        destinationPublicId: endpoints[1] ?? last,
      });
    }
    let direction: 0 | 1;
    if (trip.directionId === null) {
      direction = first === endpoints[0] ? 0 : 1;
      if (!warnings.includes('direction_id absent; deterministic endpoint orientation was used')) {
        warnings.push('direction_id absent; deterministic endpoint orientation was used');
      }
    } else direction = trip.directionId;
    const hash = hashServicePattern(stationPublicIds);
    const patternKey = `${branchKey}\0${direction}\0${hash}`;
    if (!patternsByKey.has(patternKey)) {
      patternsByKey.set(patternKey, {
        key: patternKey,
        publicId: `pattern-${hash.slice(0, 20)}`,
        branchKey,
        direction,
        hash,
        stationPublicIds,
        name: `${route.shortName ?? route.longName} ${first}–${last}`,
      });
    }
    tripMappings.push({ tripId: trip.id, branchKey, patternKey });
  }
  if (collapsedAdjacentStationCalls > 0) {
    warnings.push(
      `Collapsed ${collapsedAdjacentStationCalls} consecutive duplicate canonical-station calls in stable service-pattern topology; versioned stop times were preserved`,
    );
  }

  let effectiveFrom: string | null = null;
  let effectiveUntil: string | null = null;
  const feedInfoPath = files.get('feed_info.txt');
  if (feedInfoPath !== undefined) {
    for await (const row of readCsvRecords(feedInfoPath, {
      file: 'feed_info.txt',
      required: ['feed_publisher_name', 'feed_publisher_url', 'feed_lang'],
      optional: ['default_lang', 'feed_start_date', 'feed_end_date', 'feed_version', 'feed_contact_email', 'feed_contact_url'],
    }, limits.maxRowBytes)) {
      if (effectiveFrom !== null || effectiveUntil !== null) break;
      effectiveFrom = optional(row.feed_start_date) === null ? null : date(row.feed_start_date ?? '', 'feed_start_date', 'feed_info.txt');
      effectiveUntil = optional(row.feed_end_date) === null ? null : date(row.feed_end_date ?? '', 'feed_end_date', 'feed_info.txt');
    }
  }

  const retained: Record<keyof EntityCounts, number> = {
    routes: routes.length,
    trips: trips.length,
    stops: stops.length,
    stopTimes: stopTimes.length,
    calendarServices: calendarServices.size,
    calendarExceptions: calendarExceptions.length,
    shapes: retainedShapeIds.size,
    shapePoints: shapePoints.length,
  };
  const discarded = Object.fromEntries(
    (Object.keys(parsed) as (keyof EntityCounts)[]).map((key) => [key, Math.max(0, parsed[key] - retained[key])]),
  ) as unknown as EntityCounts;

  return {
    routes,
    trips,
    stops,
    stopTimes,
    calendarServices: [...calendarServices.values()].sort((left, right) => left.id.localeCompare(right.id)),
    calendarExceptions: calendarExceptions.sort((left, right) => left.serviceId.localeCompare(right.serviceId) || left.date.localeCompare(right.date)),
    shapePoints,
    shapeIds: [...retainedShapeIds].sort(),
    lines: [...linesBySlug.values()].sort((left, right) => left.slug.localeCompare(right.slug)),
    stations: stations.sort((left, right) => left.publicId.localeCompare(right.publicId)),
    branches: [...branchesByKey.values()].sort((left, right) => left.key.localeCompare(right.key)),
    patterns: [...patternsByKey.values()].sort((left, right) => left.key.localeCompare(right.key)),
    tripMappings,
    parsed,
    retained,
    discarded,
    warnings,
    effectiveFrom,
    effectiveUntil,
  };
}
