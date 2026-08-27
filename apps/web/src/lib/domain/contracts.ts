export type Lang = "es" | "en";
export type DataMode = "fixture" | "postgres";

export type EvidenceState = "reported_only" | "observed_presence" | "skipped" | "canceled" | "missing_evidence" | "pending";
export type PrecisionKind = "reported" | "calculated" | "mixed" | "aggregate" | "schematic-inferred";
export type Confidence = "high" | "medium" | "low" | "unavailable";
export type InformationOrigin = "reported" | "inferred" | "unavailable";
export type DirectionId = 0 | 1;

export type CapabilityUnavailableReason = "not-supported" | "not-provided";
export type Capability<T> =
  | { readonly status: "available"; readonly value: T }
  | { readonly status: "insufficient-sample" }
  | { readonly status: "unavailable"; readonly reason: CapabilityUnavailableReason };

export interface CoverageMeta {
  readonly scheduled: number;
  readonly observed: number;
  readonly ratio: number | null;
}

export type SourceStatus = "healthy" | "stale" | "unavailable" | "overnight" | "historical" | "reference";
export type FreshnessState = "fresh" | "stale" | "unknown" | "not-applicable";
export type FinalizationState = "finalized" | "processing" | "unknown";

export type AlgorithmProvenance =
  | { readonly kind: "none" }
  | { readonly kind: "single"; readonly version: string }
  | { readonly kind: "mixed"; readonly versions: readonly string[] };

export interface ResponseMeta {
  readonly generatedAt: string;
  readonly source: {
    readonly status: SourceStatus;
    readonly freshness: {
      readonly state: FreshnessState;
      readonly sourceAt: string | null;
      readonly staleAfterSeconds: number | null;
    };
  };
  readonly coverage: CoverageMeta;
  readonly finalization: {
    readonly state: FinalizationState;
    readonly finalizedAt: string | null;
  };
  readonly provenance: AlgorithmProvenance;
  readonly precision: PrecisionKind;
  readonly cache: "origin" | "offline-cache";
  readonly serviceDate: string | null;
}

export interface LocalizedName { readonly es: string; readonly en: string }
export interface LocalizedSlug { readonly es: string; readonly en: string }
export interface LineRef { readonly id: string; readonly slug: string; readonly code: string; readonly name: LocalizedName; readonly color: string }
export interface StationRef { readonly id: string; readonly slug: LocalizedSlug; readonly name: LocalizedName }
export interface SearchResult { readonly kind: "line" | "station"; readonly id: string; readonly slug: LocalizedSlug; readonly code: string | null; readonly name: LocalizedName }
export interface SearchResponse { readonly meta: ResponseMeta; readonly query: string; readonly results: readonly SearchResult[] }

export type DelayBucketId = "early" | "punctual" | "delay-2-5" | "delay-5-10" | "delay-10-15" | "delay-15-plus";
export interface DelayBucket { readonly id: DelayBucketId; readonly count: number; readonly minSeconds: number | null; readonly maxSeconds: number | null }
export interface SummaryStats {
  readonly scheduled: number;
  readonly observed: number;
  readonly punctuality: number | null;
  readonly meanDelaySeconds: number | null;
  readonly medianDelaySeconds: number | null;
  readonly p90DelaySeconds: number | null;
  readonly canceled: number | null;
  readonly missing: number | null;
  readonly distribution: readonly DelayBucket[];
}
export interface LinePerformance extends LineRef { readonly stats: Capability<SummaryStats>; readonly activeTrains: number }

export interface DirectionDescriptor { readonly id: DirectionId; readonly headsign: LocalizedName | null; readonly from: StationRef | null; readonly to: StationRef | null }
export type PositionBasis = "reported-stop" | "feed-inferred" | "schedule-inferred" | "unavailable";
export type TrainPosition =
  | { readonly kind: "at_station"; readonly stationId: string; readonly basis: "reported-stop" | "feed-inferred"; readonly confidence: Exclude<Confidence, "unavailable"> }
  | { readonly kind: "between_stations"; readonly fromStationId: string; readonly toStationId: string; readonly progress: number | null; readonly basis: "feed-inferred" | "schedule-inferred"; readonly confidence: Exclude<Confidence, "unavailable"> }
  | { readonly kind: "unknown"; readonly stationHintId: string | null; readonly basis: "unavailable"; readonly confidence: "low" | "unavailable" };

export interface TrainFieldEvidence {
  readonly origin: InformationOrigin;
  readonly confidence: Confidence;
}

export interface TrainDetail {
  readonly id: string;
  readonly journeyId: string;
  readonly serviceDate: string;
  readonly line: LineRef;
  readonly patternId: string | null;
  readonly direction: DirectionDescriptor | null;
  readonly headsign: LocalizedName | null;
  readonly destination: StationRef | null;
  readonly currentStation: StationRef | null;
  readonly previousStation: StationRef | null;
  readonly nextStation: StationRef | null;
  readonly position: TrainPosition;
  readonly scheduledArrivalAt: string | null;
  readonly probableArrivalAt: string | null;
  readonly renfeReportedArrivalAt: string | null;
  readonly observedPresenceAt: string | null;
  readonly observedPastArrivalAt: string | null;
  readonly delaySeconds: number | null;
  readonly state: EvidenceState;
  readonly sourceAt: string | null;
  readonly information: {
    readonly servicePattern: TrainFieldEvidence;
    readonly direction: TrainFieldEvidence;
    readonly headsign: TrainFieldEvidence;
    readonly destination: TrainFieldEvidence;
    readonly currentStation: TrainFieldEvidence;
    readonly previousStation: TrainFieldEvidence;
    readonly nextStation: TrainFieldEvidence;
    readonly scheduledArrival: TrainFieldEvidence;
    readonly probableArrival: TrainFieldEvidence;
    readonly reportedArrival: TrainFieldEvidence;
    readonly observedPresence: TrainFieldEvidence;
    readonly delay: TrainFieldEvidence;
  };
}

export interface SchematicStop { readonly station: StationRef; readonly order: number }
export interface SchematicPattern { readonly id: string; readonly branchSlug: string; readonly direction: DirectionDescriptor; readonly stops: readonly SchematicStop[]; readonly destination: StationRef | null }
export interface Comparison { readonly punctuality: number | null; readonly meanDelaySeconds: number | null; readonly sample: number }
export interface LiveNetworkResponse { readonly meta: ResponseMeta; readonly stats: SummaryStats; readonly lines: readonly LinePerformance[] }
export interface LiveContextResponse { readonly meta: ResponseMeta; readonly context: LineRef | StationRef; readonly stats: SummaryStats; readonly comparison: Capability<Comparison>; readonly patterns: readonly SchematicPattern[]; readonly trains: readonly TrainDetail[] }

export interface LandingDelayPoint { readonly at: string; readonly totalDelaySeconds: number | null }
export interface LandingOverviewResponse {
  readonly meta: ResponseMeta;
  readonly activeTrains: number;
  readonly activeDelaySeconds: number;
  readonly dayDelaySeconds: number;
  readonly trend: readonly LandingDelayPoint[];
}

export interface HistoryFilters { readonly from: string; readonly to: string; readonly weekdays: readonly number[]; readonly hour: number | null; readonly direction: DirectionId | null }
export interface HistoryPoint { readonly date: string; readonly scheduled: number; readonly observed: number; readonly punctuality: number | null; readonly meanDelaySeconds: number | null; readonly coverage: number | null }
export interface RankingItem { readonly id: string; readonly label: string; readonly sample: number; readonly meanDelaySeconds: number | null; readonly punctuality: number | null }
export interface HourWeekdayItem { readonly weekday: number; readonly hour: number; readonly scheduled: number; readonly sample: number; readonly meanDelaySeconds: number | null; readonly coverage: number | null }
export interface SegmentDelayItem { readonly id: string; readonly label: string; readonly direction: DirectionId; readonly sample: number; readonly addedDelaySeconds: number | null }
export interface VolumeReliabilityItem { readonly id: string; readonly label: string; readonly scheduled: number; readonly sample: number; readonly meanDelaySeconds: number | null; readonly punctuality: number | null; readonly coverage: number | null }
export interface HistoryInsights {
  readonly stations: Capability<readonly RankingItem[]>;
  readonly hours: Capability<readonly RankingItem[]>;
  readonly hourWeekday: Capability<readonly HourWeekdayItem[]>;
  readonly volumeReliability: Capability<readonly VolumeReliabilityItem[]>;
  readonly segments: Capability<readonly SegmentDelayItem[]>;
  readonly scheduleSlots: Capability<readonly RankingItem[]>;
}
export interface HistoryResponse {
  readonly meta: ResponseMeta;
  readonly context: { readonly kind: "network" | "line" | "station"; readonly label: string; readonly id: string; readonly slug: LocalizedSlug | null };
  readonly filters: HistoryFilters;
  readonly stats: SummaryStats;
  readonly trend: readonly HistoryPoint[];
  readonly rankings: Capability<readonly RankingItem[]>;
  readonly insights: HistoryInsights;
  readonly directions: readonly DirectionDescriptor[];
}

export interface MatrixCell { readonly journeyId: string; readonly stationId: string; readonly scheduledAt: string; readonly reportedAt: string | null; readonly delaySeconds: number | null; readonly state: EvidenceState }
export interface MatrixJourney { readonly id: string; readonly label: string; readonly direction: DirectionDescriptor | null }
export interface MatrixResponse { readonly meta: ResponseMeta; readonly line: LineRef; readonly date: string; readonly stations: readonly StationRef[]; readonly journeys: readonly MatrixJourney[]; readonly cells: readonly MatrixCell[] }
export type MatrixResult =
  | { readonly status: "available"; readonly matrix: MatrixResponse }
  | { readonly status: "unavailable"; readonly reason: "retention" | "no-data" | "not-supported" }
  | { readonly status: "failed"; readonly reason: "temporarily-unavailable" | "result-too-large" };
