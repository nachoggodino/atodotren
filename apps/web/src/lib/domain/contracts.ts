export type Lang = "es" | "en";
export type DataMode = "fixture" | "postgres";
export type DataStatus = "live" | "paused" | "stale" | "outage" | "cached" | "overnight";
export type PrecisionKind = "reported" | "calculated" | "mixed" | "aggregate" | "schematic-inferred";
export type EvidenceState = "reported_only" | "observed_presence" | "skipped" | "canceled" | "missing_evidence" | "pending";

export interface CoverageMeta {
  readonly scheduled: number;
  readonly observed: number;
  readonly ratio: number | null;
}

export interface ResponseMeta {
  readonly generatedAt: string;
  readonly sourceAt: string | null;
  readonly status: DataStatus;
  readonly stale: boolean;
  readonly coverage: CoverageMeta;
  readonly finalized: boolean;
  readonly algorithmVersion: string | null;
  readonly precision: PrecisionKind;
  readonly exact: boolean;
  readonly cache: "origin" | "offline";
  readonly serviceDate: string | null;
}

export interface LocalizedName {
  readonly es: string;
  readonly en: string;
}

export interface LineRef {
  readonly id: string;
  readonly slug: string;
  readonly code: string;
  readonly name: LocalizedName;
  readonly color: string;
}

export interface StationRef {
  readonly id: string;
  readonly slug: { readonly es: string; readonly en: string };
  readonly name: LocalizedName;
}

export interface SearchResult {
  readonly kind: "line" | "station";
  readonly id: string;
  readonly slug: { readonly es: string; readonly en: string };
  readonly code: string | null;
  readonly name: LocalizedName;
}

export interface SearchResponse {
  readonly meta: ResponseMeta;
  readonly query: string;
  readonly results: readonly SearchResult[];
}

export interface SummaryStats {
  readonly scheduled: number;
  readonly observed: number;
  readonly punctuality: number | null;
  readonly meanDelaySeconds: number | null;
  readonly medianDelaySeconds: number | null;
  readonly canceled: number;
  readonly missing: number;
  readonly distribution: readonly number[];
}

export interface LinePerformance extends LineRef {
  readonly stats: SummaryStats;
  readonly activeTrains: number;
}

export interface TrainPosition {
  readonly kind: "at_station" | "between_stations" | "unknown";
  readonly stationId: string | null;
  readonly fromStationId: string | null;
  readonly toStationId: string | null;
  readonly progress: number | null;
  readonly basis: "reported-stop" | "feed-inferred" | "unavailable";
  readonly confidence: "high" | "medium" | "low" | "unavailable";
}

export interface TrainDetail {
  readonly id: string;
  readonly journeyId: string;
  readonly serviceDate: string;
  readonly line: LineRef;
  readonly destination: StationRef | null;
  readonly position: TrainPosition;
  readonly scheduledArrivalAt: string | null;
  readonly probableArrivalAt: string | null;
  readonly renfeReportedArrivalAt: string | null;
  readonly observedPresenceAt: string | null;
  readonly delaySeconds: number | null;
  readonly state: EvidenceState;
  readonly sourceAt: string | null;
}

export interface SchematicStop {
  readonly station: StationRef;
  readonly order: number;
  readonly x: number;
  readonly y: number;
}

export interface LiveNetworkResponse {
  readonly meta: ResponseMeta;
  readonly stats: SummaryStats;
  readonly lines: readonly LinePerformance[];
}

export interface LiveContextResponse {
  readonly meta: ResponseMeta;
  readonly context: LineRef | StationRef;
  readonly stats: SummaryStats;
  readonly comparison: { readonly label: string; readonly punctuality: number | null; readonly meanDelaySeconds: number | null };
  readonly stops: readonly SchematicStop[];
  readonly trains: readonly TrainDetail[];
}

export interface HistoryFilters {
  readonly from: string;
  readonly to: string;
  readonly weekdays: readonly number[];
  readonly hour: number | null;
  readonly direction: 0 | 1 | null;
}

export interface HistoryPoint {
  readonly date: string;
  readonly scheduled: number;
  readonly observed: number;
  readonly punctuality: number | null;
  readonly meanDelaySeconds: number | null;
  readonly coverage: number | null;
}

export interface RankingItem {
  readonly id: string;
  readonly label: string;
  readonly sample: number;
  readonly meanDelaySeconds: number | null;
  readonly punctuality: number | null;
}

export interface HistoryResponse {
  readonly meta: ResponseMeta;
  readonly context: { readonly kind: "network" | "line" | "station"; readonly label: string; readonly id: string };
  readonly filters: HistoryFilters;
  readonly stats: SummaryStats;
  readonly trend: readonly HistoryPoint[];
  readonly rankings: readonly RankingItem[];
}

export interface MatrixCell {
  readonly journeyId: string;
  readonly stationId: string;
  readonly scheduledAt: string;
  readonly reportedAt: string | null;
  readonly delaySeconds: number | null;
  readonly state: EvidenceState;
}

export interface MatrixJourney {
  readonly id: string;
  readonly label: string;
  readonly direction: 0 | 1 | null;
}

export interface MatrixResponse {
  readonly meta: ResponseMeta;
  readonly line: LineRef;
  readonly date: string;
  readonly stations: readonly StationRef[];
  readonly journeys: readonly MatrixJourney[];
  readonly cells: readonly MatrixCell[];
}
