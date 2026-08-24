import type { StaticTripCandidate } from './types.js';

const MADRID_TIMEZONE = 'Europe/Madrid';
const MAX_INFERENCE_DISTANCE_SECONDS = 18 * 60 * 60;

export interface ServiceDateAnchor {
  readonly instantSeconds: number;
  readonly scheduledSeconds: number;
}

export interface InferredServiceDate {
  readonly date: string;
  readonly distanceSeconds: number;
}

function wallParts(instantMs: number): readonly number[] {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: MADRID_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instantMs)).filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  return [values.year ?? 0, values.month ?? 0, values.day ?? 0,
    values.hour ?? 0, values.minute ?? 0, values.second ?? 0];
}

function wallEpoch(parts: readonly number[]): number {
  return Date.UTC(parts[0] ?? 0, (parts[1] ?? 1) - 1, parts[2] ?? 1,
    parts[3] ?? 0, parts[4] ?? 0, parts[5] ?? 0);
}

function serviceInstantSeconds(serviceDate: string, seconds: number): number {
  const [year, month, day] = serviceDate.split('-').map(Number) as [number, number, number];
  const intendedMs = Date.UTC(year, month - 1, day) + seconds * 1000;
  const offsets = new Set<number>();
  for (let deltaHours = -48; deltaHours <= 48; deltaHours += 3) {
    const sample = intendedMs + deltaHours * 3_600_000;
    offsets.add(wallEpoch(wallParts(sample)) - sample);
  }
  const candidates = [...offsets].map((offset) => intendedMs - offset);
  const exact = candidates.filter((candidate) => wallEpoch(wallParts(candidate)) === intendedMs);
  if (exact.length > 0) return Math.max(...exact) / 1000;
  const shifted = candidates.map((candidate) => ({ candidate, wall: wallEpoch(wallParts(candidate)) }))
    .filter(({ wall }) => wall > intendedMs)
    .sort((left, right) => left.wall - right.wall || left.candidate - right.candidate);
  const compatible = shifted[0];
  if (compatible === undefined) throw new RangeError('Cannot resolve Madrid service time');
  return compatible.candidate / 1000;
}

export function inferCandidateServiceDate(
  candidate: StaticTripCandidate,
  anchors: readonly ServiceDateAnchor[],
  fallbackInstantSeconds?: number,
): InferredServiceDate | undefined {
  const dates = [...(candidate.serviceDates ?? [])];
  if (dates.length === 0) return undefined;
  const usableAnchors = anchors.length > 0 ? anchors
    : fallbackInstantSeconds === undefined || candidate.firstTimeSeconds === undefined ? [] : [{
      instantSeconds: fallbackInstantSeconds,
      scheduledSeconds: candidate.firstTimeSeconds,
    }];
  if (usableAnchors.length === 0) return undefined;
  const scored = dates.map((date) => ({
    date,
    distanceSeconds: Math.min(...usableAnchors.map((anchor) => Math.abs(
      anchor.instantSeconds - serviceInstantSeconds(date, anchor.scheduledSeconds),
    ))),
  })).sort((left, right) => left.distanceSeconds - right.distanceSeconds || left.date.localeCompare(right.date));
  const best = scored[0];
  const second = scored[1];
  if (best === undefined || best.distanceSeconds > MAX_INFERENCE_DISTANCE_SECONDS ||
      second?.distanceSeconds === best.distanceSeconds) return undefined;
  return best;
}
