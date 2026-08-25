import type { Confidence, DirectionDescriptor, EvidenceState, PrecisionKind, ResponseMeta, SourceStatus } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";

export function sourceStatusLabel(status: SourceStatus, messages: Messages): string {
  switch (status) {
    case "healthy": return messages.common.sourceHealthy;
    case "stale": return messages.common.sourceStale;
    case "unavailable": return messages.common.sourceUnavailable;
    case "overnight": return messages.common.sourceOvernight;
    case "historical": return messages.common.sourceHistorical;
    case "reference": return messages.common.sourceReference;
  }
}

export function freshnessLabel(state: ResponseMeta["source"]["freshness"]["state"], messages: Messages): string {
  switch (state) {
    case "fresh": return messages.common.freshnessFresh;
    case "stale": return messages.common.freshnessStale;
    case "unknown": return messages.common.freshnessUnknown;
    case "not-applicable": return messages.common.freshnessNotApplicable;
  }
}

export function precisionLabel(precision: PrecisionKind, messages: Messages): string {
  switch (precision) {
    case "reported": return messages.common.precisionReported;
    case "calculated": return messages.common.precisionCalculated;
    case "mixed": return messages.common.precisionMixed;
    case "aggregate": return messages.common.precisionAggregate;
    case "schematic-inferred": return messages.common.precisionSchematic;
  }
}

export function evidenceLabel(state: EvidenceState, messages: Messages): string {
  switch (state) {
    case "reported_only": return messages.common.evidenceReportedOnly;
    case "observed_presence": return messages.common.evidenceObservedPresence;
    case "skipped": return messages.common.evidenceSkipped;
    case "canceled": return messages.common.evidenceCanceled;
    case "missing_evidence": return messages.common.evidenceMissing;
    case "pending": return messages.common.evidencePending;
  }
}

export function confidenceLabel(confidence: Confidence, messages: Messages): string {
  switch (confidence) {
    case "high": return messages.common.confidenceHigh;
    case "medium": return messages.common.confidenceMedium;
    case "low": return messages.common.confidenceLow;
    case "unavailable": return messages.common.confidenceUnavailable;
  }
}

export function directionLabel(direction: DirectionDescriptor, lang: "es" | "en", messages: Messages): string {
  if (direction.headsign !== null) return direction.headsign[lang];
  if (direction.from !== null && direction.to !== null) return `${direction.from.name[lang]} → ${direction.to.name[lang]}`;
  return direction.id === 0 ? messages.common.directionA : messages.common.directionB;
}
