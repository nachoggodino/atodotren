import type { FreshnessState, PrecisionKind, SourceStatus } from "./contracts";
import { delayBand } from "./delay-policy";

export type LiveStatusLevel = "good" | "warning" | "bad" | "unknown";

export const LIVE_COVERAGE_THRESHOLDS = {
  badMax: 0.33,
  goodMin: 0.66,
} as const;

export const LIVE_PUNCTUALITY_THRESHOLDS = {
  warningMin: 0.6,
  goodMin: 0.8,
} as const;

export function coverageStatusLevel(ratio: number | null): LiveStatusLevel {
  if (ratio === null) return "unknown";
  if (ratio <= LIVE_COVERAGE_THRESHOLDS.badMax) return "bad";
  if (ratio < LIVE_COVERAGE_THRESHOLDS.goodMin) return "warning";
  return "good";
}

export function punctualityStatusLevel(punctuality: number | null): LiveStatusLevel {
  if (punctuality === null) return "unknown";
  if (punctuality >= LIVE_PUNCTUALITY_THRESHOLDS.goodMin) return "good";
  if (punctuality >= LIVE_PUNCTUALITY_THRESHOLDS.warningMin) return "warning";
  return "bad";
}

export function delayStatusLevel(seconds: number | null): LiveStatusLevel {
  switch (delayBand(seconds)) {
    case "punctual": return "good";
    case "mild": return "warning";
    case "delayed":
    case "severe": return "bad";
    case "unknown": return "unknown";
  }
}

export function sourceStatusLevel(status: SourceStatus): LiveStatusLevel {
  switch (status) {
    case "healthy": return "good";
    case "stale":
    case "overnight": return "warning";
    case "unavailable": return "bad";
    case "historical":
    case "reference": return "unknown";
  }
}

export function freshnessStatusLevel(state: FreshnessState): LiveStatusLevel {
  return state === "fresh" ? "good" : "bad";
}

export function precisionStatusLevel(precision: PrecisionKind): LiveStatusLevel {
  switch (precision) {
    case "reported": return "good";
    case "calculated":
    case "mixed":
    case "aggregate": return "warning";
    case "schematic-inferred": return "bad";
  }
}
