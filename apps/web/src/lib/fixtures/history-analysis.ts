import type { DirectionDescriptor, HistoryFilters } from "@/lib/domain/contracts";
import type {
  HistoryAnalysisContext,
  HistoryHeatmapCell,
  HistoryHeatmapDimension,
  HistoryHeatmapRequest,
  HistoryHeatmapResponse,
  HistoryTrendPoint,
} from "@/lib/domain/history-analysis";
import { historyHeatmapTypeUsesSegments } from "@/lib/domain/history-analysis";
import { calendarDayOfWeek, calendarDaysInclusive, offsetCalendarDate } from "@/lib/domain/dates";
import { MADRID_LINES } from "@/lib/domain/network";
import { fixtureStations } from "./catalog";

function seed(text: string): number {
  return [...text].reduce((value, char) => (value * 31 + char.charCodeAt(0)) % 997, 17);
}

function selectedHours(filters: HistoryFilters): readonly number[] {
  const from = filters.hour ?? 0;
  const to = filters.hour === null ? 23 : filters.hourTo ?? filters.hour;
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function selectedWeekdays(filters: HistoryFilters): readonly number[] {
  return filters.weekdays.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : filters.weekdays;
}

function metricCell(x: string, xLabel: string, xOrder: number, y: string, yLabel: string, yOrder: number, segment: boolean): HistoryHeatmapCell {
  const value = seed(`${x}:${y}`);
  const scheduled = 55 + (value % 110);
  const observed = Math.max(8, scheduled - 4 - (value % 18));
  const punctual = Math.round(observed * (0.61 + (value % 28) / 100));
  const mean = 70 + (value % 360);
  const canceled = value % 9;
  return {
    x, xLabel, xOrder, y, yLabel, yOrder,
    scheduled,
    observed,
    punctuality: punctual / observed,
    meanDelaySeconds: segment ? Math.round((value % 240) - 75) : mean,
    medianDelaySeconds: segment ? Math.round((value % 210) - 60) : Math.max(0, mean - 55),
    cancellationRate: canceled / scheduled,
    coverage: observed / scheduled,
    addedDelaySeconds: segment ? Math.round((value % 240) - 75) : null,
  };
}

function dimensions(request: HistoryHeatmapRequest): {
  readonly xDimension: HistoryHeatmapDimension;
  readonly yDimension: HistoryHeatmapDimension;
  readonly xs: readonly { key: string; label: string; order: number }[];
  readonly ys: readonly { key: string; label: string; order: number }[];
} {
  const hours = selectedHours(request.filters).map((hour) => ({ key: String(hour), label: `${hour}h`, order: hour }));
  const weekdays = selectedWeekdays(request.filters).map((day) => ({ key: String(day), label: String(day), order: day }));
  const lines = MADRID_LINES.map((line, index) => ({ key: line.slug, label: line.code, order: index }));
  const stations = fixtureStations.slice(0, 8).map((station, index) => ({ key: station.id, label: station.name.es, order: index }));
  const segments = stations.slice(0, -1).map((station, index) => ({ key: `segment-${index}`, label: `${station.name.es} → ${stations[index + 1]?.label ?? station.name.es}`, order: index }));

  switch (request.type) {
    case "hour-weekday": return { xDimension: "hour", yDimension: "weekday", xs: hours, ys: weekdays };
    case "station-hour": return { xDimension: "hour", yDimension: "station", xs: hours, ys: stations };
    case "station-weekday": return { xDimension: "weekday", yDimension: "station", xs: weekdays, ys: stations };
    case "line-hour": return { xDimension: "hour", yDimension: "line", xs: hours, ys: lines };
    case "line-weekday": return { xDimension: "weekday", yDimension: "line", xs: weekdays, ys: lines };
    case "segment-hour": return { xDimension: "hour", yDimension: "segment", xs: hours, ys: segments };
    case "segment-weekday": return { xDimension: "weekday", yDimension: "segment", xs: weekdays, ys: segments };
  }
}

export function fixtureHistoryTrend(context: HistoryAnalysisContext, filters: HistoryFilters): readonly HistoryTrendPoint[] {
  const totalDays = Math.max(1, Math.min(calendarDaysInclusive(filters.from, filters.to), 366));
  return Array.from({ length: totalDays }, (_, index) => {
    const date = offsetCalendarDate(filters.from, index);
    const weekday = calendarDayOfWeek(date);
    const value = seed(`${context.kind}:${context.key}:${date}`);
    const scheduled = 950 + (value % 500);
    const observed = Math.round(scheduled * (0.78 + (value % 17) / 100));
    const punctual = Math.round(observed * (0.62 + ((weekday * 3 + value) % 27) / 100));
    const mean = 95 + (value % 310);
    return {
      date,
      scheduled,
      observed,
      punctuality: observed === 0 ? null : punctual / observed,
      meanDelaySeconds: mean,
      medianDelaySeconds: Math.max(0, mean - 48),
      delayedStops: Math.max(0, observed - punctual),
      coverage: scheduled === 0 ? null : observed / scheduled,
    };
  });
}

export function fixtureHistoryHeatmap(request: HistoryHeatmapRequest): HistoryHeatmapResponse {
  const { xDimension, yDimension, xs, ys } = dimensions(request);
  const segment = historyHeatmapTypeUsesSegments(request.type);
  const cells = ys.flatMap((y) => xs.map((x) => metricCell(x.key, x.label, x.order, y.key, y.label, y.order, segment)));
  return {
    type: request.type,
    xDimension,
    yDimension,
    lineSlug: request.context.kind === "line" ? request.context.key : request.lineSlug,
    direction: request.filters.direction ?? request.direction,
    cells,
  };
}

export function fixtureLineDirections(slug: string): readonly DirectionDescriptor[] {
  const code = MADRID_LINES.find((line) => line.slug === slug)?.code ?? slug.toUpperCase();
  return [
    { id: 0, headsign: { es: `${code} destino 1`, en: `${code} destination 1` }, from: null, to: null },
    { id: 1, headsign: { es: `${code} destino 2`, en: `${code} destination 2` }, from: null, to: null },
  ];
}
