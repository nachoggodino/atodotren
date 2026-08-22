import type { CanonicalEvidence, CanonicalStopState } from './types.js';

export interface ReductionCounts { stale: number; duplicate: number }

export function emptyStop(stopSequence: number, scheduledArrivalAt: Date): CanonicalStopState {
  return {
    stopSequence, scheduledArrivalAt, renfeArrivalAt: null, providedDelay: null,
    derivedDelay: null, discrepancy: null, firstPresenceAt: null, selectedDelay: null,
    selectedDelaySource: null, status: 'pending', firstCapturedAt: null,
    selectedCapturedAt: null, selectedSourceAt: null, selectedIdempotencyKey: null,
    stopRelationship: 'SCHEDULED', selectedSignature: null,
  };
}

function evidenceInstant(evidence: CanonicalEvidence): Date {
  return evidence.sourceTimestamp === null
    ? evidence.capturedAt
    : new Date(evidence.sourceTimestamp * 1000);
}

function freshness(evidence: CanonicalEvidence): number {
  return evidence.sourceTimestamp === null ? evidence.capturedAt.getTime() : evidence.sourceTimestamp * 1000;
}

export function applyStopEvidence(
  state: CanonicalStopState,
  evidence: CanonicalEvidence,
  counts: ReductionCounts,
): void {
  state.firstCapturedAt ??= evidence.capturedAt;
  if (evidence.classification === 'observed_presence') {
    const observedAt = evidenceInstant(evidence);
    if (state.firstPresenceAt === null || observedAt < state.firstPresenceAt) state.firstPresenceAt = observedAt;
    if (state.status !== 'skipped' && state.status !== 'canceled') state.status = 'observed_presence';
    return;
  }
  if (evidence.classification === 'stop_skipped') {
    state.status = 'skipped';
    state.stopRelationship = evidence.stopRelationship;
    return;
  }
  if (evidence.classification !== 'reported_prediction') return;
  const signature = JSON.stringify([evidence.arrivalTime, evidence.arrivalDelay, evidence.stopRelationship]);
  if (signature === state.selectedSignature) {
    counts.duplicate += 1;
    return;
  }
  const previousFreshness = state.selectedSourceAt?.getTime() ?? state.selectedCapturedAt?.getTime();
  if (previousFreshness !== undefined && freshness(evidence) <= previousFreshness) {
    counts.stale += 1;
    return;
  }
  state.selectedSignature = signature;
  state.renfeArrivalAt = evidence.arrivalTime === null ? null : new Date(evidence.arrivalTime * 1000);
  state.providedDelay = evidence.arrivalDelay;
  state.derivedDelay = state.renfeArrivalAt === null
    ? null
    : Math.trunc((state.renfeArrivalAt.getTime() - state.scheduledArrivalAt.getTime()) / 1000);
  state.discrepancy = state.providedDelay === null || state.derivedDelay === null
    ? null
    : state.providedDelay - state.derivedDelay;
  state.selectedDelay = state.derivedDelay ?? state.providedDelay;
  state.selectedDelaySource = state.derivedDelay === null
    ? (state.providedDelay === null ? null : 'provided_delay')
    : 'arrival_time';
  state.selectedCapturedAt = evidence.capturedAt;
  state.selectedSourceAt = evidence.sourceTimestamp === null ? null : new Date(evidence.sourceTimestamp * 1000);
  state.selectedIdempotencyKey = evidence.idempotencyKey;
  state.stopRelationship = evidence.stopRelationship;
  if (state.status === 'pending') state.status = 'reported_only';
}

export function applyCancellation(states: readonly CanonicalStopState[]): 'canceled' | 'partially_canceled' {
  const completed = states.filter((state) => state.firstPresenceAt !== null).map((state) => state.stopSequence);
  const cutoff = completed.length === 0 ? null : Math.max(...completed);
  for (const state of states) {
    if (cutoff === null || state.stopSequence > cutoff) {
      state.status = 'canceled';
      state.selectedDelay = null;
      state.selectedDelaySource = null;
    } else if (state.status === 'pending') {
      state.status = 'missing_evidence';
    }
  }
  return cutoff === null ? 'canceled' : 'partially_canceled';
}
