import type { DelayBucket, DelayBucketId } from "./contracts";

export const PUNCTUALITY_THRESHOLD_SECONDS = 120;

export const DELAY_BUCKETS: readonly Omit<DelayBucket, "count">[] = [
  { id: "early", minSeconds: null, maxSeconds: -1 },
  { id: "punctual", minSeconds: 0, maxSeconds: PUNCTUALITY_THRESHOLD_SECONDS },
  { id: "delay-2-5", minSeconds: PUNCTUALITY_THRESHOLD_SECONDS + 1, maxSeconds: 300 },
  { id: "delay-5-10", minSeconds: 301, maxSeconds: 600 },
  { id: "delay-10-15", minSeconds: 601, maxSeconds: 900 },
  { id: "delay-15-plus", minSeconds: 901, maxSeconds: null },
] as const;

export function emptyDelayDistribution(): readonly DelayBucket[] {
  return DELAY_BUCKETS.map((bucket) => ({ ...bucket, count: 0 }));
}

export function delayBucketForSeconds(seconds: number): DelayBucketId {
  if (seconds < 0) return "early";
  if (seconds <= PUNCTUALITY_THRESHOLD_SECONDS) return "punctual";
  if (seconds <= 300) return "delay-2-5";
  if (seconds <= 600) return "delay-5-10";
  if (seconds <= 900) return "delay-10-15";
  return "delay-15-plus";
}

export function distributionFromCounts(counts: Readonly<Partial<Record<DelayBucketId, number>>>): readonly DelayBucket[] {
  return DELAY_BUCKETS.map((bucket) => ({ ...bucket, count: Math.max(0, Math.trunc(counts[bucket.id] ?? 0)) }));
}

export function delayBand(seconds: number | null): "unknown" | "punctual" | "mild" | "delayed" | "severe" {
  if (seconds === null) return "unknown";
  if (seconds <= PUNCTUALITY_THRESHOLD_SECONDS) return "punctual";
  if (seconds <= 300) return "mild";
  if (seconds <= 600) return "delayed";
  return "severe";
}
