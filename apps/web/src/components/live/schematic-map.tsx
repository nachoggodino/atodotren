"use client";

import * as Ariakit from "@ariakit/react";
import { ArrowRight, TrainFront } from "lucide-react";
import { useMemo } from "react";
import type { DirectionId, Lang, SchematicPattern, StationRef, TrainDetail, TrainFieldEvidence } from "@/lib/domain/contracts";
import { formatDelay, formatMadridTime } from "@/lib/domain/format";
import { layoutSchematicPatterns, pointForTrain, schematicHeight, schematicWidth } from "@/lib/domain/schematic";
import type { Messages } from "@/messages/types";

const STATION_LABEL_SINGLE_LINE_MAX = 18;
const STATION_LABEL_FIRST_LINE_MAX = 17;
const STATION_LABEL_MIN_SPLIT_INDEX = 7;
const STATION_LABEL_SECOND_LINE_MAX = 18;

function trainColor(train: TrainDetail): string {
  if (train.position.kind === "unknown" || train.delaySeconds === null) return "var(--unknown)";
  return train.delaySeconds > 120 ? "var(--danger)" : "var(--success)";
}

function stationLabel(value: string): readonly [string, string | null] {
  if (value.length <= STATION_LABEL_SINGLE_LINE_MAX) return [value, null];
  const split = value.lastIndexOf(" ", STATION_LABEL_SINGLE_LINE_MAX);
  if (split < STATION_LABEL_MIN_SPLIT_INDEX) return [`${value.slice(0, STATION_LABEL_FIRST_LINE_MAX)}…`, null];
  const first = value.slice(0, split);
  const rest = value.slice(split + 1);
  return [first, rest.length > STATION_LABEL_SECOND_LINE_MAX + 1 ? `${rest.slice(0, STATION_LABEL_SECOND_LINE_MAX)}…` : rest];
}

function destinationLabel(pattern: SchematicPattern, lang: Lang, messages: Messages): string {
  const destination = pattern.destination ?? pattern.direction.to;
  return destination === null ? (pattern.direction.id === 0 ? messages.common.directionA : messages.common.directionB) : `${messages.live.towards} ${destination.name[lang]}`;
}

function trainDestination(train: TrainDetail, pattern: SchematicPattern, lang: Lang, messages: Messages): string {
  const station = train.destination ?? train.direction?.to ?? pattern.destination ?? pattern.direction.to;
  if (station !== null) return station.name[lang];
  const headsign = train.headsign?.[lang] ?? train.direction?.headsign?.[lang];
  if (headsign !== null && headsign !== undefined) return headsign;
  return pattern.direction.id === 0 ? messages.common.directionA : messages.common.directionB;
}

function stationForId(pattern: SchematicPattern, stationId: string): StationRef | null {
  return pattern.stops.find((stop) => stop.station.id === stationId)?.station ?? null;
}

function positionField(train: TrainDetail, pattern: SchematicPattern, lang: Lang, messages: Messages): { readonly label: string; readonly value: string; readonly evidence: TrainFieldEvidence } {
  if (train.position.kind === "at_station") return { label: messages.live.stoppedAt, value: train.currentStation?.name[lang] ?? stationForId(pattern, train.position.stationId)?.name[lang] ?? messages.common.unavailable, evidence: train.information.currentStation };
  if (train.position.kind === "between_stations") return { label: messages.live.nextStop, value: train.nextStation?.name[lang] ?? stationForId(pattern, train.position.toStationId)?.name[lang] ?? messages.common.unavailable, evidence: train.information.nextStation };
  return { label: messages.live.nextStop, value: train.nextStation?.name[lang] ?? messages.common.unavailable, evidence: train.information.nextStation };
}

function informationLabel(evidence: TrainFieldEvidence, messages: Messages): string {
  if (evidence.origin === "reported") return messages.common.precisionReported;
  if (evidence.origin === "inferred") return messages.common.precisionSchematic;
  return messages.common.unavailable;
}

function DetailField({ label, value, evidence, messages, className = "" }: { readonly label: string; readonly value: string; readonly evidence?: TrainFieldEvidence; readonly messages: Messages; readonly className?: string }) {
  return (
    <div className={className}>
      <dt className="text-[8px] font-bold uppercase tracking-[.1em] text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-bold leading-tight">{value}</dd>
      {evidence === undefined ? null : <small className="mt-0.5 block text-[9px] leading-tight text-muted">{informationLabel(evidence, messages)}</small>}
    </div>
  );
}

function TrainMarker({ train, pattern, x, y, lang, messages }: { readonly train: TrainDetail; readonly pattern: SchematicPattern; readonly x: number; readonly y: number; readonly lang: Lang; readonly messages: Messages }) {
  const position = positionField(train, pattern, lang, messages);
  return (
    <Ariakit.PopoverProvider placement="top">
      <Ariakit.PopoverDisclosure aria-label={`${train.id}, ${formatDelay(train.delaySeconds, lang)}, ${position.value}`} className="absolute z-10 grid size-10 -translate-x-1/2 -translate-y-1/2 touch-manipulation select-none place-items-center bg-transparent p-0 outline-none transition-[color,transform,opacity] hover:scale-110 active:scale-95 active:opacity-75 focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-primary" style={{ left: x, top: y, color: trainColor(train) }} type="button">
        <span className="grid size-5 place-items-center rounded-[35%] border border-border bg-surface-strong shadow-sm" data-testid="train-marker-squircle"><TrainFront aria-hidden="true" className="size-3.5" strokeWidth={2.5} /></span>
      </Ariakit.PopoverDisclosure>
      <Ariakit.Popover className="z-[80] w-[20rem] max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-surface-strong p-3 shadow-[var(--shadow-float)] outline-none" gutter={7} portal data-testid="train-detail">
        <div>
          <div className="flex min-w-0 items-center gap-1.5"><TrainFront aria-hidden="true" className="size-4 shrink-0" style={{ color: trainColor(train) }} /><span className="shrink-0 text-sm font-black">{train.id}</span><span aria-hidden="true" className="text-xs text-muted">·</span><span className="min-w-0 truncate text-xs font-semibold text-muted">{messages.live.towards} {trainDestination(train, pattern, lang, messages)}</span></div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
            <DetailField label={position.label} value={position.value} evidence={position.evidence} messages={messages} />
            <DetailField label={messages.live.delay} value={formatDelay(train.delaySeconds, lang)} evidence={train.information.delay} messages={messages} />
            <DetailField label={messages.live.nextArrival} value={formatMadridTime(train.scheduledArrivalAt, lang, true)} evidence={train.information.scheduledArrival} messages={messages} />
            <DetailField label={messages.live.probableArrival} value={formatMadridTime(train.probableArrivalAt, lang, true)} evidence={train.information.probableArrival} messages={messages} />
            <DetailField className="col-span-2" label={messages.live.lastPositionUpdate} value={formatMadridTime(train.sourceAt, lang, true)} messages={messages} />
          </dl>
        </div>
      </Ariakit.Popover>
    </Ariakit.PopoverProvider>
  );
}

export function SchematicMap({ patterns, trains, directionByJourney, lineColor, lang, messages }: { readonly patterns: readonly SchematicPattern[]; readonly trains: readonly TrainDetail[]; readonly directionByJourney: ReadonlyMap<string, DirectionId>; readonly lineColor: string; readonly lang: Lang; readonly messages: Messages }) {
  const plottedPatterns = useMemo(() => layoutSchematicPatterns(patterns), [patterns]);
  const patternById = useMemo(() => new Map(plottedPatterns.map(({ pattern }) => [pattern.id, pattern])), [plottedPatterns]);
  const plottedTrains = useMemo(() => trains.flatMap((train) => {
    if (train.sourceAt === null) return [];
    const point = pointForTrain(train, plottedPatterns, directionByJourney.get(train.journeyId) ?? null);
    if (point === null) return [];
    const pattern = patternById.get(point.patternId);
    return pattern === undefined ? [] : [{ train, point, pattern }];
  }), [directionByJourney, trains, plottedPatterns, patternById]);
  const width = schematicWidth(plottedPatterns);
  const height = schematicHeight(plottedPatterns);

  return (
    <div className="overflow-x-auto" data-testid="schematic-map"><div className="relative" style={{ width, height }}>
      <svg aria-label={messages.live.schematic} className="absolute inset-0" role="img" viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
        {plottedPatterns.map(({ pattern, stops, destinationLabelY }) => <g key={pattern.id}><g transform={`translate(22 ${destinationLabelY})`}><ArrowRight aria-hidden="true" height="11" width="11" x="0" y="-8" /><text x="16" y="0" fill="var(--muted)" fontSize="10" fontWeight="700">{destinationLabel(pattern, lang, messages)}</text></g><path d={stops.map((stop, index) => `${index === 0 ? "M" : "L"}${stop.x} ${stop.y}`).join(" ")} fill="none" stroke={lineColor} strokeLinecap="round" strokeLinejoin="round" strokeWidth="8" opacity=".86" />{stops.map((stop) => { const [first, second] = stationLabel(stop.station.name[lang]); return <g key={`${pattern.id}-${stop.station.id}`}><circle cx={stop.x} cy={stop.y} r="6" fill="var(--background)" stroke={lineColor} strokeWidth="3" /><text x={stop.x} y={stop.y + 20} textAnchor="middle" fill="var(--foreground)" fontSize="9" fontWeight="700"><tspan x={stop.x}>{first}</tspan>{second === null ? null : <tspan x={stop.x} dy="11">{second}</tspan>}</text></g>; })}</g>)}
      </svg>
      {plottedTrains.map(({ train, point, pattern }) => <TrainMarker key={train.id} lang={lang} messages={messages} pattern={pattern} train={train} x={point.x} y={point.y} />)}
    </div></div>
  );
}
