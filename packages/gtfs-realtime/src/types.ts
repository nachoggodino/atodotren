export type FeedKind = 'trip_updates' | 'vehicle_positions' | 'service_alerts';
export type MatchingMethod =
  | 'active-exact-trip'
  | 'previous-exact-trip'
  | 'active-unique-fallback'
  | 'previous-unique-fallback';
export type MatchDisposition = MatchingMethod | 'ambiguous' | 'unmatched' | 'non-madrid';

export interface TripDescriptor {
  readonly tripId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly startDate?: string | undefined;
  readonly startTime?: string | undefined;
  readonly scheduleRelationship: string;
}

export interface DecodedStopUpdate {
  readonly stopSequence?: number | undefined;
  readonly stopId?: string | undefined;
  readonly arrivalTime?: number | undefined;
  readonly arrivalDelay?: number | undefined;
  readonly relationship: string;
}

export interface DecodedTripUpdate {
  readonly kind: 'trip_update';
  readonly entityId: string;
  readonly trip: TripDescriptor;
  readonly timestamp?: number | undefined;
  readonly stopUpdates: readonly DecodedStopUpdate[];
}

export interface DecodedVehiclePosition {
  readonly kind: 'vehicle_position';
  readonly entityId: string;
  readonly trip: TripDescriptor;
  readonly vehicleId?: string | undefined;
  readonly timestamp?: number | undefined;
  readonly latitude?: number | undefined;
  readonly longitude?: number | undefined;
  readonly bearing?: number | undefined;
  readonly speed?: number | undefined;
  readonly currentStopSequence?: number | undefined;
  readonly stopId?: string | undefined;
  readonly currentStatus: string;
}

export interface AlertPeriod {
  readonly start?: number | undefined;
  readonly end?: number | undefined;
}

export interface AlertTargetDescriptor {
  readonly routeId?: string | undefined;
  readonly stopId?: string | undefined;
  readonly trip?: TripDescriptor | undefined;
}

export interface DecodedAlert {
  readonly kind: 'alert';
  readonly entityId: string;
  readonly activePeriods: readonly AlertPeriod[];
  readonly targets: readonly AlertTargetDescriptor[];
  readonly cause: string;
  readonly effect: string;
  readonly headerText: string;
  readonly descriptionText: string;
  readonly url?: string | undefined;
}

export type DecodedEntity = DecodedTripUpdate | DecodedVehiclePosition | DecodedAlert;

export interface InvalidEntity {
  readonly entityId?: string | undefined;
  readonly tripId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly stopId?: string | undefined;
  readonly reasonCode: string;
  readonly diagnosticFields: Readonly<Record<string, string | number | boolean>>;
}

export interface DecodedFeed {
  readonly feedKind: FeedKind;
  readonly headerTimestamp: number;
  readonly entities: readonly DecodedEntity[];
  readonly invalidEntities: readonly InvalidEntity[];
  readonly entityTotal: number;
}

export interface StaticStop {
  readonly stopSequence: number;
  readonly stopId: string;
  readonly stationId: string;
  readonly arrivalSeconds?: number | undefined;
}

export interface StaticTripCandidate {
  readonly feedVersionId: string;
  readonly versionPosition: 'active' | 'previous';
  readonly tripId: string;
  readonly routeId: string;
  readonly serviceId: string;
  readonly firstTimeSeconds?: number | undefined;
  readonly lineId: string;
  readonly branchId: string;
  readonly servicePatternId: string;
  readonly shapeId?: string | undefined;
  readonly stops: readonly StaticStop[];
  readonly serviceDates?: ReadonlySet<string> | undefined;
}

export interface StaticMatchIndex {
  readonly candidates: readonly StaticTripCandidate[];
  readonly knownNationalTripIds?: ReadonlySet<string> | undefined;
  readonly alertRoutes?: ReadonlyMap<string, { readonly feedVersionId: string; readonly lineId: string }> | undefined;
  readonly alertStops?: ReadonlyMap<string, { readonly feedVersionId: string; readonly stationId: string }> | undefined;
}

export interface ResolvedMatch {
  readonly disposition: MatchDisposition;
  readonly candidate?: StaticTripCandidate | undefined;
}

export interface StopEvidenceOperation {
  readonly kind: 'stop_evidence';
  readonly idempotencyKey: string;
  readonly evidenceKey: string;
  readonly evidenceChecksum: string;
  readonly capturedAt: string;
  readonly feedKind: 'trip_updates' | 'vehicle_positions';
  readonly feedVersionId: string;
  readonly sourceTripId: string;
  readonly serviceDate?: string | undefined;
  readonly startTime?: string | undefined;
  readonly startDateSource: 'provided' | 'inferred' | 'missing';
  readonly stopId?: string | undefined;
  readonly stopSequence?: number | undefined;
  readonly stationId?: string | undefined;
  readonly arrivalTime?: number | undefined;
  readonly arrivalDelay?: number | undefined;
  readonly tripRelationship: string;
  readonly stopRelationship: string;
  readonly sourceTimestamp?: number | undefined;
  readonly matchingMethod: MatchingMethod;
  readonly matchingVersion: string;
  readonly classification: 'reported_prediction' | 'trip_cancellation' | 'stop_skipped' | 'observed_presence';
}

export interface VehicleStateOperation {
  readonly kind: 'vehicle_state';
  readonly idempotencyKey: string;
  readonly stateKey: string;
  readonly capturedAt: string;
  readonly feedVersionId: string;
  readonly sourceTripId: string;
  readonly serviceDate?: string | undefined;
  readonly startTime?: string | undefined;
  readonly lineId: string;
  readonly branchId: string;
  readonly servicePatternId: string;
  readonly vehicleId?: string | undefined;
  readonly entityId: string;
  readonly latitude?: number | undefined;
  readonly longitude?: number | undefined;
  readonly bearing?: number | undefined;
  readonly speed?: number | undefined;
  readonly currentStopSequence?: number | undefined;
  readonly currentStopId?: string | undefined;
  readonly currentStationId?: string | undefined;
  readonly currentStatus: string;
  readonly latestStopDelay?: number | undefined;
  readonly vehicleTimestamp?: number | undefined;
  readonly feedHeaderTimestamp: number;
  readonly shapeId?: string | undefined;
  readonly projectionInput: 'raw_position' | 'stop_sequence' | 'stop_id' | 'none';
  readonly projectionConfidence?: number | undefined;
  readonly contentChecksum: string;
}

export interface AlertTargetOperation {
  readonly order: number;
  readonly feedVersionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly lineId?: string | undefined;
  readonly stopId?: string | undefined;
  readonly stationId?: string | undefined;
  readonly tripId?: string | undefined;
}

export interface ServiceAlertOperation {
  readonly kind: 'service_alert';
  readonly idempotencyKey: string;
  readonly sourceAlertId: string;
  readonly feedHeaderTimestamp: number;
  readonly capturedAt: string;
  readonly activePeriods: readonly AlertPeriod[];
  readonly cause: string;
  readonly effect: string;
  readonly headerText: string;
  readonly descriptionText: string;
  readonly url?: string | undefined;
  readonly contentChecksum: string;
  readonly targets: readonly AlertTargetOperation[];
}

export interface QuarantineOperation {
  readonly kind: 'quarantine';
  readonly idempotencyKey: string;
  readonly capturedAt: string;
  readonly feedKind: FeedKind;
  readonly feedHeaderTimestamp?: number | undefined;
  readonly entityId?: string | undefined;
  readonly tripId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly stopId?: string | undefined;
  readonly reasonCode: string;
  readonly diagnosticFields: Readonly<Record<string, string | number | boolean>>;
}

export type PendingOperation =
  | StopEvidenceOperation
  | VehicleStateOperation
  | ServiceAlertOperation
  | QuarantineOperation;

export interface NormalizedBatch {
  readonly feedKind: FeedKind;
  readonly capturedAt: string;
  readonly headerTimestamp: number;
  readonly operations: readonly PendingOperation[];
  readonly filteredEntities: readonly unknown[];
  readonly matchedMadridCount: number;
  readonly nonMadridCount: number;
  readonly unmatchedCount: number;
  readonly invalidCount: number;
}

export interface PollRecord {
  readonly idempotencyKey: string;
  readonly feedKind: FeedKind;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly capturedAt: string;
  readonly feedHeaderTimestamp?: number | undefined;
  readonly httpStatus?: number | undefined;
  readonly resultClass: string;
  readonly responseBytes: number;
  readonly entityTotal: number;
  readonly matchedMadridCount: number;
  readonly nonMadridCount: number;
  readonly unmatchedCount: number;
  readonly invalidCount: number;
  readonly responseDurationMs: number;
  readonly persistenceDurationMs: number;
  readonly errorCode?: string | undefined;
}
