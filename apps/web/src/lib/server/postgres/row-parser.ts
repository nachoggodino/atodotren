import type { DirectionId, EvidenceState } from "@/lib/domain/contracts";
import { isCalendarDate } from "@/lib/domain/dates";
import { DataContractError } from "@/lib/domain/errors";
import type { RawPostgresRow } from "./client";

function fail(context: string, field: string, value: unknown): never {
  throw new DataContractError(context, `invalid ${field}: ${String(value)}`);
}

function stringField(row: RawPostgresRow, field: string, context: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.trim() === "") return fail(context, field, value);
  return value;
}

function nullableStringField(row: RawPostgresRow, field: string, context: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") return fail(context, field, value);
  return value;
}

function integerValue(value: unknown, context: string, field: string, allowNegative = false): number {
  if (typeof value !== "number" && typeof value !== "string") return fail(context, field, value);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!allowNegative && parsed < 0)) return fail(context, field, value);
  return parsed;
}

function nullableIntegerField(row: RawPostgresRow, field: string, context: string, allowNegative = false): number | null {
  const value = row[field];
  return value === null || value === undefined ? null : integerValue(value, context, field, allowNegative);
}

function dateField(row: RawPostgresRow, field: string, context: string): string {
  const value = row[field];
  const date = value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === "string" ? value.slice(0, 10) : "";
  if (!isCalendarDate(date)) return fail(context, field, value);
  return date;
}

function timestampValue(value: unknown, context: string, field: string): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) return fail(context, field, value);
  return date.toISOString();
}

function nullableTimestampField(row: RawPostgresRow, field: string, context: string): string | null {
  const value = row[field];
  return value === null || value === undefined ? null : timestampValue(value, context, field);
}

function directionValue(value: unknown, context: string, field = "direction"): DirectionId {
  const parsed = integerValue(value, context, field);
  if (parsed !== 0 && parsed !== 1) return fail(context, field, value);
  return parsed;
}

function directionField(row: RawPostgresRow, field: string, context: string): DirectionId {
  return directionValue(row[field], context, field);
}

function evidenceValue(value: unknown, context: string, field = "evidence_status"): EvidenceState {
  if (value === "reported_only" || value === "observed_presence" || value === "skipped" || value === "canceled" || value === "missing_evidence" || value === "pending") return value;
  return fail(context, field, value);
}

function histogramField(row: RawPostgresRow, field: string, context: string): readonly number[] {
  const value = row[field];
  if (!Array.isArray(value) || value.length !== 72) return fail(context, field, value);
  return value.map((item, index) => integerValue(item, context, `${field}[${index}]`));
}

export interface LineCatalogRow {
  readonly slug: string;
  readonly publicCode: string;
  readonly nameEs: string;
  readonly nameEn: string;
  readonly color: string | null;
}

export function parseLineCatalogRow(row: RawPostgresRow): LineCatalogRow {
  const context = "api.line_catalog";
  return {
    slug: stringField(row, "slug", context),
    publicCode: stringField(row, "public_code", context),
    nameEs: stringField(row, "name_es", context),
    nameEn: stringField(row, "name_en", context),
    color: nullableStringField(row, "color", context),
  };
}

export interface StationCatalogRow {
  readonly id: string;
  readonly slugEs: string;
  readonly slugEn: string;
  readonly nameEs: string;
  readonly nameEn: string;
}

export function parseStationCatalogRow(row: RawPostgresRow, context = "api.station_catalog"): StationCatalogRow {
  return {
    id: stringField(row, row.station_id === undefined ? "public_id" : "station_id", context),
    slugEs: stringField(row, "station_slug_es" in row ? "station_slug_es" : "slug_es", context),
    slugEn: stringField(row, "station_slug_en" in row ? "station_slug_en" : "slug_en", context),
    nameEs: stringField(row, "station_name_es" in row ? "station_name_es" : "name_es", context),
    nameEn: stringField(row, "station_name_en" in row ? "station_name_en" : "name_en", context),
  };
}

export interface AggregateRow {
  readonly serviceDate: string;
  readonly scheduled: number;
  readonly observed: number;
  readonly punctual: number;
  readonly signedDelaySum: number;
  readonly canceled: number | null;
  readonly missing: number | null;
  readonly histogram: readonly number[];
  readonly algorithmVersions: readonly string[];
}

export function parseAggregateRow(row: RawPostgresRow, context: string): AggregateRow {
  const minVersion = nullableStringField(row, "aggregate_algorithm_version", context);
  const maxVersion = nullableStringField(row, "aggregate_algorithm_version_max", context);
  return {
    serviceDate: dateField(row, "service_date", context),
    scheduled: integerValue(row.scheduled_opportunities, context, "scheduled_opportunities"),
    observed: integerValue(row.valid_delay_observations, context, "valid_delay_observations"),
    punctual: integerValue(row.punctual_count, context, "punctual_count"),
    signedDelaySum: integerValue(row.signed_delay_sum, context, "signed_delay_sum", true),
    canceled: nullableIntegerField(row, "canceled_count", context),
    missing: nullableIntegerField(row, "missing_evidence_count", context),
    histogram: histogramField(row, "delay_histogram", context),
    algorithmVersions: [minVersion, maxVersion].filter((value): value is string => value !== null),
  };
}

export interface SearchRow {
  readonly kind: "line" | "station";
  readonly id: string;
  readonly slugEs: string;
  readonly slugEn: string;
  readonly code: string | null;
  readonly nameEs: string;
  readonly nameEn: string;
}

export function parseSearchRow(row: RawPostgresRow): SearchRow {
  const context = "api.catalog_search";
  const kind = stringField(row, "entity_kind", context);
  if (kind !== "line" && kind !== "station") return fail(context, "entity_kind", kind);
  return {
    kind,
    id: stringField(row, "stable_id", context),
    slugEs: stringField(row, "slug_es", context),
    slugEn: stringField(row, "slug_en", context),
    code: nullableStringField(row, "public_code", context),
    nameEs: stringField(row, "name_es", context),
    nameEn: stringField(row, "name_en", context),
  };
}

export interface LiveVehicleRow {
  readonly stateKey: string;
  readonly capturedAt: string;
  readonly serviceDate: string;
  readonly sourceTripId: string;
  readonly vehicleId: string | null;
  readonly lineSlug: string;
  readonly publicCode: string;
  readonly lineNameEs: string;
  readonly lineNameEn: string;
  readonly currentStopSequence: number | null;
  readonly currentStationId: string | null;
  readonly currentStationSlugEs: string | null;
  readonly currentStationSlugEn: string | null;
  readonly currentStationNameEs: string | null;
  readonly currentStationNameEn: string | null;
  readonly currentStatus: string;
  readonly latestStopDelay: number | null;
  readonly vehicleTimestamp: string | null;
  readonly journeyId: string | null;
}

export function parseLiveVehicleRow(row: RawPostgresRow): LiveVehicleRow {
  const context = "api.live_vehicle";
  const currentStationId = nullableStringField(row, "current_station_id", context);
  const stationField = (field: string): string | null => currentStationId === null ? null : nullableStringField(row, field, context);
  return {
    stateKey: stringField(row, "state_key", context),
    capturedAt: timestampValue(row.captured_at, context, "captured_at"),
    serviceDate: dateField(row, "service_date", context),
    sourceTripId: stringField(row, "source_trip_id", context),
    vehicleId: nullableStringField(row, "vehicle_id", context),
    lineSlug: stringField(row, "line_slug", context),
    publicCode: stringField(row, "public_code", context),
    lineNameEs: stringField(row, "line_name_es", context),
    lineNameEn: stringField(row, "line_name_en", context),
    currentStopSequence: nullableIntegerField(row, "current_stop_sequence", context),
    currentStationId,
    currentStationSlugEs: stationField("current_station_slug_es"),
    currentStationSlugEn: stationField("current_station_slug_en"),
    currentStationNameEs: stationField("current_station_name_es"),
    currentStationNameEn: stationField("current_station_name_en"),
    currentStatus: stringField(row, "current_status", context),
    latestStopDelay: nullableIntegerField(row, "latest_stop_delay", context, true),
    vehicleTimestamp: nullableTimestampField(row, "vehicle_timestamp", context),
    journeyId: row.journey_id === null || row.journey_id === undefined ? null : String(integerValue(row.journey_id, context, "journey_id")),
  };
}

export interface TopologyRow extends StationCatalogRow {
  readonly patternId: string;
  readonly branchSlug: string;
  readonly direction: DirectionId;
  readonly stopOrder: number;
}

export function parseTopologyRow(row: RawPostgresRow): TopologyRow {
  const context = "api.schematic_pattern_stop";
  return {
    ...parseStationCatalogRow(row, context),
    patternId: stringField(row, "pattern_id", context),
    branchSlug: stringField(row, "branch_slug", context),
    direction: directionField(row, "direction", context),
    stopOrder: integerValue(row.stop_order, context, "stop_order"),
  };
}

export interface ServiceDayStateRow {
  readonly serviceDate: string;
  readonly status: "verified" | "failed";
  readonly finalizedAt: string;
  readonly algorithmVersion: string;
}

export function parseServiceDayStateRow(row: RawPostgresRow): ServiceDayStateRow {
  const context = "api.service_day_state";
  const status = stringField(row, "status", context);
  if (status !== "verified" && status !== "failed") return fail(context, "status", status);
  return {
    serviceDate: dateField(row, "service_date", context),
    status,
    finalizedAt: timestampValue(row.finalized_at, context, "finalized_at"),
    algorithmVersion: stringField(row, "aggregate_algorithm_version", context),
  };
}

export interface JourneyRow {
  readonly serviceDate: string;
  readonly journeyId: string;
  readonly sourceTripId: string;
  readonly lineSlug: string;
  readonly publicCode: string;
  readonly direction: DirectionId;
  readonly stationId: string;
  readonly stationNameEs: string;
  readonly stationNameEn: string;
  readonly scheduledArrivalAt: string | null;
  readonly renfeArrivalAt: string | null;
  readonly selectedDelaySeconds: number | null;
  readonly observedPresenceAt: string | null;
  readonly evidenceState: EvidenceState;
  readonly sourceAt: string | null;
  readonly algorithmVersion: string;
}

export function parseJourneyRow(row: RawPostgresRow): JourneyRow {
  const context = "api.recent_journey";
  return {
    serviceDate: dateField(row, "service_date", context),
    journeyId: String(integerValue(row.journey_id, context, "journey_id")),
    sourceTripId: stringField(row, "source_trip_id", context),
    lineSlug: stringField(row, "line_slug", context),
    publicCode: stringField(row, "public_code", context),
    direction: directionField(row, "direction", context),
    stationId: stringField(row, "station_id", context),
    stationNameEs: stringField(row, "station_name_es", context),
    stationNameEn: stringField(row, "station_name_en", context),
    scheduledArrivalAt: nullableTimestampField(row, "scheduled_arrival_at", context),
    renfeArrivalAt: nullableTimestampField(row, "renfe_arrival_at", context),
    selectedDelaySeconds: nullableIntegerField(row, "selected_delay_seconds", context, true),
    observedPresenceAt: nullableTimestampField(row, "first_stopped_presence_at", context),
    evidenceState: evidenceValue(row.evidence_status, context),
    sourceAt: nullableTimestampField(row, "evidence_selected_captured_at", context),
    algorithmVersion: stringField(row, "canonical_algorithm_version", context),
  };
}

export interface MatrixRow {
  readonly serviceDate: string;
  readonly journeyId: string;
  readonly sourceTripId: string;
  readonly direction: DirectionId;
  readonly stopSequence: number;
  readonly station: StationCatalogRow;
  readonly scheduledArrivalAt: string;
  readonly reportedAt: string | null;
  readonly selectedDelaySeconds: number | null;
  readonly evidenceState: EvidenceState;
  readonly sourceAt: string | null;
}

export function parseMatrixRow(row: RawPostgresRow): MatrixRow {
  const context = "api.recent_line_matrix";
  const scheduledArrivalAt = nullableTimestampField(row, "scheduled_arrival_at", context);
  if (scheduledArrivalAt === null) return fail(context, "scheduled_arrival_at", row.scheduled_arrival_at);
  return {
    serviceDate: dateField(row, "service_date", context),
    journeyId: String(integerValue(row.journey_id, context, "journey_id")),
    sourceTripId: stringField(row, "source_trip_id", context),
    direction: directionField(row, "direction", context),
    stopSequence: integerValue(row.stop_sequence, context, "stop_sequence"),
    station: parseStationCatalogRow(row, context),
    scheduledArrivalAt,
    reportedAt: nullableTimestampField(row, "renfe_arrival_at", context),
    selectedDelaySeconds: nullableIntegerField(row, "selected_delay_seconds", context, true),
    evidenceState: evidenceValue(row.evidence_status, context),
    sourceAt: nullableTimestampField(row, "evidence_selected_captured_at", context),
  };
}

export function parseHealthTimestamp(row: RawPostgresRow | undefined): string | null {
  if (row === undefined) return null;
  return nullableTimestampField(row, "latest_successful_poll_at", "api.live_health");
}
