export type EvidenceStatus = 'pending' | 'reported_only' | 'observed_presence' | 'skipped' | 'canceled' | 'missing_evidence';

export interface CanonicalEvidence {
  readonly classification: 'reported_prediction' | 'trip_cancellation' | 'stop_skipped' | 'observed_presence';
  readonly stopSequence: number | null;
  readonly capturedAt: Date;
  readonly sourceTimestamp: number | null;
  readonly idempotencyKey: string;
  readonly arrivalTime: number | null;
  readonly arrivalDelay: number | null;
  readonly stopRelationship: string;
}

export interface CanonicalStopState {
  readonly stopSequence: number;
  readonly scheduledArrivalAt: Date;
  renfeArrivalAt: Date | null;
  providedDelay: number | null;
  derivedDelay: number | null;
  discrepancy: number | null;
  firstPresenceAt: Date | null;
  selectedDelay: number | null;
  selectedDelaySource: 'arrival_time' | 'provided_delay' | null;
  status: EvidenceStatus;
  firstCapturedAt: Date | null;
  selectedCapturedAt: Date | null;
  selectedSourceAt: Date | null;
  selectedIdempotencyKey: string | null;
  stopRelationship: string;
  selectedSignature: string | null;
}

export interface CanonicalReport {
  readonly command: 'canonicalize' | 'close-journeys' | 'repair-journeys';
  readonly journeysCreated: number;
  readonly journeysUpdated: number;
  readonly journeysClosed: number;
  readonly journeyStopsMaterialized: number;
  readonly statuses: Readonly<Record<EvidenceStatus, number>>;
  readonly discrepancyCount: number;
  readonly ignoredStaleEvidence: number;
  readonly ignoredDuplicateEvidence: number;
  readonly unresolvedInput: number;
  readonly ambiguousInput: number;
  readonly algorithmVersion: string;
  readonly repairVersion: number;
  readonly durationMs: number;
  readonly errors: Readonly<Record<string, number>>;
}
