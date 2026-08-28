import type { DirectionId, SchematicPattern, SchematicStop, TrainDetail } from "./contracts";

export interface PlottedStop extends SchematicStop {
  readonly x: number;
  readonly y: number;
}

export interface PlottedPattern {
  readonly pattern: SchematicPattern;
  readonly stops: readonly PlottedStop[];
  readonly stopByStation: ReadonlyMap<string, PlottedStop>;
}

export interface TrainPoint {
  readonly x: number;
  readonly y: number;
  readonly patternId: string;
}

const STOP_SPACING = 88;
const PATTERN_SPACING = 108;
const ORIGIN_X = 58;
const ORIGIN_Y = 52;

export function layoutSchematicPatterns(patterns: readonly SchematicPattern[]): readonly PlottedPattern[] {
  return patterns.map((pattern, patternIndex) => {
    const stops = [...pattern.stops]
      .sort((left, right) => left.order - right.order)
      .map((stop, stopIndex) => ({
        ...stop,
        x: ORIGIN_X + stopIndex * STOP_SPACING,
        y: ORIGIN_Y + patternIndex * PATTERN_SPACING,
      }));
    return { pattern, stops, stopByStation: new Map(stops.map((stop) => [stop.station.id, stop])) };
  });
}

export function schematicWidth(patterns: readonly PlottedPattern[]): number {
  const furthest = Math.max(0, ...patterns.flatMap((pattern) => pattern.stops.map((stop) => stop.x)));
  return Math.max(620, furthest + 78);
}

export function schematicHeight(patterns: readonly PlottedPattern[]): number {
  if (patterns.length === 0) return 170;
  return Math.max(170, ORIGIN_Y + (patterns.length - 1) * PATTERN_SPACING + 72);
}

function patternForTrain(train: TrainDetail, patterns: readonly PlottedPattern[], directionHint: DirectionId | null): PlottedPattern | undefined {
  if (train.patternId !== null) {
    const exact = patterns.find((candidate) => candidate.pattern.id === train.patternId);
    if (exact !== undefined) return exact;
  }
  const stationId = train.position.kind === "at_station"
    ? train.position.stationId
    : train.position.kind === "unknown"
      ? train.position.stationHintId
      : null;
  if (stationId === null) return undefined;
  const direction = train.direction?.id ?? directionHint;
  if (direction !== null) {
    const directional = patterns.find((candidate) => candidate.pattern.direction.id === direction && candidate.stopByStation.has(stationId));
    if (directional !== undefined) return directional;
  }
  return patterns.find((candidate) => candidate.stopByStation.has(stationId));
}

export function pointForTrain(train: TrainDetail, patterns: readonly PlottedPattern[], directionHint: DirectionId | null = null): TrainPoint | null {
  const pattern = patternForTrain(train, patterns, directionHint);
  if (pattern === undefined) return null;
  if (train.position.kind === "unknown") {
    if (train.position.stationHintId === null) return null;
    const stop = pattern.stopByStation.get(train.position.stationHintId);
    return stop === undefined ? null : { x: stop.x, y: stop.y, patternId: pattern.pattern.id };
  }
  if (train.position.kind === "at_station") {
    const stop = pattern.stopByStation.get(train.position.stationId);
    return stop === undefined ? null : { x: stop.x, y: stop.y, patternId: pattern.pattern.id };
  }
  const from = pattern.stopByStation.get(train.position.fromStationId);
  const to = pattern.stopByStation.get(train.position.toStationId);
  if (from === undefined || to === undefined) return null;
  const progress = train.position.progress ?? 0.5;
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
    patternId: pattern.pattern.id,
  };
}
