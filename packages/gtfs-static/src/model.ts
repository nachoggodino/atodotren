import type { EntityCounts } from './types.js';

export interface GtfsRoute {
  readonly id: string;
  readonly agencyId: string | null;
  readonly shortName: string | null;
  readonly longName: string | null;
  readonly description: string | null;
  readonly type: number;
  readonly url: string | null;
  readonly color: string | null;
  readonly textColor: string | null;
  readonly sortOrder: number | null;
  readonly mappingRule: string;
}

export interface GtfsTrip {
  readonly id: string;
  readonly routeId: string;
  readonly serviceId: string;
  readonly headsign: string | null;
  readonly shortName: string | null;
  readonly directionId: 0 | 1 | null;
  readonly blockId: string | null;
  readonly shapeId: string | null;
  readonly wheelchairAccessible: number | null;
  readonly bikesAllowed: number | null;
}

export interface GtfsStopTime {
  readonly tripId: string;
  readonly sequence: number;
  readonly stopId: string;
  readonly arrivalSeconds: number | null;
  readonly departureSeconds: number | null;
  readonly headsign: string | null;
  readonly pickupType: number | null;
  readonly dropOffType: number | null;
  readonly shapeDistance: number | null;
  readonly timepoint: number | null;
}

export interface GtfsStop {
  readonly id: string;
  readonly code: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly locationType: number | null;
  readonly parentStation: string | null;
  readonly wheelchairBoarding: number | null;
  readonly platformCode: string | null;
  readonly stationPublicId: string;
  readonly stationMappingRule: string;
}

export interface CalendarService {
  readonly id: string;
  readonly weekdays: readonly [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
  readonly startDate: string | null;
  readonly endDate: string | null;
}

export interface CalendarException {
  readonly serviceId: string;
  readonly date: string;
  readonly type: 1 | 2;
}

export interface ShapePoint {
  readonly shapeId: string;
  readonly sequence: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly distance: number | null;
}

export interface StableLine {
  readonly slug: string;
  readonly publicCode: string;
  readonly name: string;
  readonly color: string | null;
  readonly textColor: string | null;
}

export interface StableStation {
  readonly publicId: string;
  readonly slug: string;
  readonly name: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

export interface StableBranch {
  readonly key: string;
  readonly slug: string;
  readonly lineSlug: string;
  readonly name: string;
  readonly originPublicId: string;
  readonly destinationPublicId: string;
}

export interface StablePattern {
  readonly key: string;
  readonly publicId: string;
  readonly branchKey: string;
  readonly direction: 0 | 1;
  readonly hash: string;
  readonly stationPublicIds: readonly string[];
  readonly name: string;
}

export interface TripMapping {
  readonly tripId: string;
  readonly branchKey: string;
  readonly patternKey: string;
}

export interface NormalizedGtfsFeed {
  readonly routes: readonly GtfsRoute[];
  readonly trips: readonly GtfsTrip[];
  readonly stops: readonly GtfsStop[];
  readonly stopTimes: readonly GtfsStopTime[];
  readonly calendarServices: readonly CalendarService[];
  readonly calendarExceptions: readonly CalendarException[];
  readonly shapePoints: readonly ShapePoint[];
  readonly shapeIds: readonly string[];
  readonly lines: readonly StableLine[];
  readonly stations: readonly StableStation[];
  readonly branches: readonly StableBranch[];
  readonly patterns: readonly StablePattern[];
  readonly tripMappings: readonly TripMapping[];
  readonly parsed: EntityCounts;
  readonly retained: EntityCounts;
  readonly discarded: EntityCounts;
  readonly warnings: readonly string[];
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
}
