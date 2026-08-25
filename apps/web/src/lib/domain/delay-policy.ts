import type { DelayBucket, DelayBucketId } from "./contracts";

export const DELAY_SEVERITY_THRESHOLDS_SECONDS = {
  punctual: 120,
  mild: 300,
  delayed: 600,
  severe: 900,
} as const;

export const PUNCTUALITY_THRESHOLD_SECONDS = DELAY_SEVERITY_THRESHOLDS_SECONDS.punctual;

export const DELAY_BUCKETS: readonly Omit<DelayBucket, "count">[] = [
  { id: "early", minSeconds: null, maxSeconds: -1 },
  { id: "punctual", minSeconds: 0, maxSeconds: PUNCTUALITY_THRESHOLD_SECONDS },
  { id: "delay-2-5", minSeconds: PUNCTUALITY_THRESHOLD_SECONDS + 1, maxSeconds: DELAY_SEVERITY_THRESHOLDS_SECONDS.mild },
  { id: "delay-5-10", minSeconds: DELAY_SEVERITY_THRESHOLDS_SECONDS.mild + 1, maxSeconds: DELAY_SEVERITY_THRESHOLDS_SECONDS.delayed },
  { id: "delay-10-15", minSeconds: DELAY_SEVERITY_THRESHOLDS_SECONDS.delayed + 1, maxSeconds: DELAY_SEVERITY_THRESHOLDS_SECONDS.severe },
  { id: "delay-15-plus", minSeconds: DELAY_SEVERITY_THRESHOLDS_SECONDS.severe + 1, maxSeconds: null },
] as const;

export function emptyDelayDistribution(): readonly DelayBucket[] {
  return DELAY_BUCKETS.map((bucket) => ({ ...bucket, count: 0 }));
}

export function delayBucketForSeconds(seconds: number): DelayBucketId {
  if (seconds < 0) return "early";
  if (seconds <= PUNCTUALITY_THRESHOLD_SECONDS) return "punctual";
  if (seconds <= DELAY_SEVERITY_THRESHOLDS_SECONDS.mild) return "delay-2-5";
  if (seconds <= DELAY_SEVERITY_THRESHOLDS_SECONDS.delayed) return "delay-5-10";
  if (seconds <= DELAY_SEVERITY_THRESHOLDS_SECONDS.severe) return "delay-10-15";
  return "delay-15-plus";
}

export function distributionFromCounts(counts: Readonly<Partial<Record<DelayBucketId, number>>>): readonly DelayBucket[] {
  return DELAY_BUCKETS.map((bucket) => ({ ...bucket, count: Math.max(0, Math.trunc(counts[bucket.id] ?? 0)) }));
}

export function delayBand(seconds: number | null): "unknown" | "punctual" | "mild" | "delayed" | "severe" {
  if (seconds === null) return "unknown";
  if (seconds <= PUNCTUALITY_THRESHOLD_SECONDS) return "punctual";
  if (seconds <= DELAY_SEVERITY_THRESHOLDS_SECONDS.mild) return "mild";
  if (seconds <= DELAY_SEVERITY_THRESHOLDS_SECONDS.delayed) return "delayed";
  return "severe";
}
