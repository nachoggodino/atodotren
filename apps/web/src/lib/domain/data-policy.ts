import type { AlgorithmProvenance, FinalizationState, PrecisionKind, ResponseMeta, SummaryStats } from "./contracts";

export const LIVE_STALE_AFTER_SECONDS = 120;

export function coverageFor(stats: SummaryStats): ResponseMeta["coverage"] {
  return { scheduled: stats.scheduled, observed: stats.observed, ratio: stats.scheduled === 0 ? null : stats.observed / stats.scheduled };
}

export function algorithmProvenance(versions: Iterable<string | null | undefined>): AlgorithmProvenance {
  const unique = [...new Set([...versions].filter((value): value is string => typeof value === "string" && value.trim() !== "").map((value) => value.trim()))].sort();
  if (unique.length === 0) return { kind: "none" };
  if (unique.length === 1) return { kind: "single", version: unique[0]! };
  return { kind: "mixed", versions: unique };
}

export function liveResponseMeta(input: {
  readonly stats: SummaryStats;
  readonly sourceAt: string | null;
  readonly activeTrains: number;
  readonly serviceDate: string;
  readonly finalization: ResponseMeta["finalization"];
  readonly provenance: AlgorithmProvenance;
  readonly precision?: PrecisionKind;
  readonly expectedOvernight?: boolean;
  readonly now?: Date;
  readonly cache?: ResponseMeta["cache"];
}): ResponseMeta {
  const now = input.now ?? new Date();
  const sourceMs = input.sourceAt === null ? Number.NaN : Date.parse(input.sourceAt);
  const stale = Number.isFinite(sourceMs) && now.getTime() - sourceMs > LIVE_STALE_AFTER_SECONDS * 1000;
  const status = input.sourceAt === null
    ? "unavailable"
    : stale
      ? "stale"
      : input.expectedOvernight === true && input.activeTrains === 0
        ? "overnight"
        : "healthy";
  const freshness = input.sourceAt === null
    ? { state: "unknown" as const, sourceAt: null, staleAfterSeconds: LIVE_STALE_AFTER_SECONDS }
    : { state: stale ? "stale" as const : "fresh" as const, sourceAt: input.sourceAt, staleAfterSeconds: LIVE_STALE_AFTER_SECONDS };
  return { generatedAt: now.toISOString(), source: { status, freshness }, coverage: coverageFor(input.stats), finalization: input.finalization, provenance: input.provenance, precision: input.precision ?? "aggregate", cache: input.cache ?? "origin", serviceDate: input.serviceDate };
}

export function historicalResponseMeta(input: {
  readonly stats: SummaryStats;
  readonly serviceDate: string | null;
  readonly finalization: ResponseMeta["finalization"];
  readonly provenance: AlgorithmProvenance;
  readonly precision?: PrecisionKind;
  readonly now?: Date;
  readonly cache?: ResponseMeta["cache"];
}): ResponseMeta {
  return { generatedAt: (input.now ?? new Date()).toISOString(), source: { status: "historical", freshness: { state: "not-applicable", sourceAt: null, staleAfterSeconds: null } }, coverage: coverageFor(input.stats), finalization: input.finalization, provenance: input.provenance, precision: input.precision ?? "aggregate", cache: input.cache ?? "origin", serviceDate: input.serviceDate };
}

export function referenceResponseMeta(version: string, now: Date = new Date()): ResponseMeta {
  return { generatedAt: now.toISOString(), source: { status: "reference", freshness: { state: "not-applicable", sourceAt: null, staleAfterSeconds: null } }, coverage: { scheduled: 0, observed: 0, ratio: null }, finalization: { state: "unknown", finalizedAt: null }, provenance: { kind: "single", version }, precision: "reported", cache: "origin", serviceDate: null };
}

export function finalizationFromStates(states: readonly { readonly state: FinalizationState; readonly finalizedAt: string | null }[]): ResponseMeta["finalization"] {
  if (states.length === 0 || states.some((item) => item.state === "unknown")) return { state: "unknown", finalizedAt: null };
  if (states.some((item) => item.state === "processing")) return { state: "processing", finalizedAt: null };
  const finalizedTimes = states.map((item) => item.finalizedAt).filter((value): value is string => value !== null).sort();
  return { state: "finalized", finalizedAt: finalizedTimes.at(-1) ?? null };
}
