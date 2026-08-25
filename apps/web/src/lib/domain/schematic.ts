import type { SchematicPattern, SchematicStop, TrainDetail } from "./contracts";

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

const STOP_SPACING = 105;
const PATTERN_SPACING = 150;
const ORIGIN_X = 70;
const ORIGIN_Y = 72;

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
  return Math.max(720, furthest + 100);
}

export function schematicHeight(patterns: readonly PlottedPattern[]): number {
  if (patterns.length === 0) return 250;
  return Math.max(250, ORIGIN_Y + (patterns.length - 1) * PATTERN_SPACING + 110);
}

export function pointForTrain(train: TrainDetail, patterns: readonly PlottedPattern[]): TrainPoint | null {
  if (train.patternId === null || train.position.kind === "unknown") return null;
  const pattern = patterns.find((candidate) => candidate.pattern.id === train.patternId);
  if (pattern === undefined) return null;
  if (train.position.kind === "at_station") {
    const stop = pattern.stopByStation.get(train.position.stationId);
    return stop === undefined ? null : { x: stop.x, y: stop.y, patternId: train.patternId };
  }
  if (train.position.progress === null) return null;
  const from = pattern.stopByStation.get(train.position.fromStationId);
  const to = pattern.stopByStation.get(train.position.toStationId);
  if (from === undefined || to === undefined) return null;
  return {
    x: from.x + (to.x - from.x) * train.position.progress,
    y: from.y + (to.y - from.y) * train.position.progress,
    patternId: train.patternId,
  };
}
