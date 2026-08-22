export interface ServiceWallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function wallParts(instantMs: number, timezone: string): ServiceWallTime {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(instantMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year ?? 0, month: values.month ?? 0, day: values.day ?? 0,
    hour: values.hour ?? 0, minute: values.minute ?? 0, second: values.second ?? 0,
  };
}

function wallEpoch(parts: ServiceWallTime): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/**
 * Converts GTFS service-day seconds through an IANA wall clock. Ambiguous fall-back
 * times select the later (standard-time) occurrence; nonexistent spring-forward
 * times move forward by the size of the gap. This matches PostgreSQL AT TIME ZONE.
 */
export function serviceTimeToInstant(serviceDate: string, seconds: number, timezone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(serviceDate) || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 359_999) {
    throw new RangeError('Service time requires YYYY-MM-DD and integer seconds from 0 through 359999');
  }
  const [year, month, day] = serviceDate.split('-').map(Number) as [number, number, number];
  const intendedMs = Date.UTC(year, month - 1, day) + seconds * 1000;
  const offsets = new Set<number>();
  for (let deltaHours = -48; deltaHours <= 48; deltaHours += 3) {
    const sample = intendedMs + deltaHours * 3_600_000;
    offsets.add(wallEpoch(wallParts(sample, timezone)) - sample);
  }
  const candidates = [...offsets].map((offset) => intendedMs - offset);
  const exact = candidates.filter((candidate) => wallEpoch(wallParts(candidate, timezone)) === intendedMs);
  if (exact.length > 0) return new Date(Math.max(...exact));
  const shifted = candidates
    .map((candidate) => ({ candidate, wall: wallEpoch(wallParts(candidate, timezone)) }))
    .filter(({ wall }) => wall > intendedMs)
    .sort((left, right) => left.wall - right.wall || left.candidate - right.candidate);
  const compatible = shifted[0];
  if (compatible === undefined) throw new RangeError(`Cannot resolve service time in ${timezone}`);
  return new Date(compatible.candidate);
}
