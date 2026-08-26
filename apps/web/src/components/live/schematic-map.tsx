"use client";

import * as Ariakit from "@ariakit/react";
import { ArrowRight, TrainFront } from "lucide-react";
import { useMemo, useState } from "react";
import type { DirectionId, Lang, SchematicPattern, TrainDetail } from "@/lib/domain/contracts";
import { delayBand } from "@/lib/domain/delay-policy";
import { formatDelay, formatMadridTime } from "@/lib/domain/format";
import { layoutSchematicPatterns, pointForTrain, schematicHeight, schematicWidth } from "@/lib/domain/schematic";
import { positionCaptionKey } from "@/lib/domain/train";
import { confidenceLabel, evidenceLabel } from "@/lib/i18n/domain-labels";
import type { Messages } from "@/messages/types";

function captionForTrain(train: TrainDetail, messages: Messages): string {
  switch (positionCaptionKey(train.position)) {
    case "reported": return messages.live.reported;
    case "inferred": return messages.live.inferred;
    case "unavailable": return messages.live.positionUnavailable;
  }
}

function trainColor(train: TrainDetail): string {
  if (train.position.kind === "unknown") return "var(--unknown)";
  switch (delayBand(train.delaySeconds)) {
    case "punctual": return "var(--success)";
    case "mild": return "var(--warning)";
    case "delayed": return "var(--accent)";
    case "severe": return "var(--danger)";
    case "unknown": return "var(--unknown)";
  }
}

function stationLabel(value: string): readonly [string, string | null] {
  if (value.length <= 18) return [value, null];
  const split = value.lastIndexOf(" ", 18);
  if (split < 7) return [`${value.slice(0, 17)}…`, null];
  const first = value.slice(0, split);
  const rest = value.slice(split + 1);
  return [first, rest.length > 19 ? `${rest.slice(0, 18)}…` : rest];
}

function destinationLabel(pattern: SchematicPattern, lang: Lang, messages: Messages): string {
  const destination = pattern.destination ?? pattern.direction.to;
  return destination === null
    ? (pattern.direction.id === 0 ? messages.common.directionA : messages.common.directionB)
    : `${messages.live.towards} ${destination.name[lang]}`;
}

export function SchematicMap({ patterns, trains, directionByJourney, lineColor, lang, messages }: { readonly patterns: readonly SchematicPattern[]; readonly trains: readonly TrainDetail[]; readonly directionByJourney: ReadonlyMap<string, DirectionId>; readonly lineColor: string; readonly lang: Lang; readonly messages: Messages }) {
  const [selected, setSelected] = useState<TrainDetail | null>(null);
  const plottedPatterns = useMemo(() => layoutSchematicPatterns(patterns), [patterns]);
  const plottedTrains = useMemo(
    () => trains.flatMap((train) => {
      if (train.sourceAt === null) return [];
      const point = pointForTrain(train, plottedPatterns, directionByJourney.get(train.journeyId) ?? null);
      return point === null ? [] : [{ train, point }];
    }),
    [directionByJourney, trains, plottedPatterns],
  );
  const width = schematicWidth(plottedPatterns);
  const height = schematicHeight(plottedPatterns);

  return (
    <Ariakit.PopoverProvider open={selected !== null} setOpen={(open) => { if (!open) setSelected(null); }} placement="top">
      <div className="overflow-x-auto" data-testid="schematic-map">
        <div className="relative" style={{ width, height }}>
          <svg aria-label={messages.live.schematic} className="absolute inset-0" role="img" viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
            {plottedPatterns.map(({ pattern, stops }) => (
              <g key={pattern.id}>
                <g transform={`translate(22 ${(stops[0]?.y ?? 52) - 24})`}>
                  <ArrowRight aria-hidden="true" height="11" width="11" x="0" y="-8" />
                  <text x="16" y="0" fill="var(--muted)" fontSize="10" fontWeight="700">{destinationLabel(pattern, lang, messages)}</text>
                </g>
                <path d={stops.map((stop, index) => `${index === 0 ? "M" : "L"}${stop.x} ${stop.y}`).join(" ")} fill="none" stroke={lineColor} strokeLinecap="round" strokeLinejoin="round" strokeWidth="8" opacity=".86" />
                {stops.map((stop) => {
                  const [first, second] = stationLabel(stop.station.name[lang]);
                  return (
                    <g key={`${pattern.id}-${stop.station.id}`}>
                      <circle cx={stop.x} cy={stop.y} r="6" fill="var(--background)" stroke={lineColor} strokeWidth="3" />
                      <text x={stop.x} y={stop.y + 20} textAnchor="middle" fill="var(--foreground)" fontSize="9" fontWeight="700">
                        <tspan x={stop.x}>{first}</tspan>
                        {second === null ? null : <tspan x={stop.x} dy="11">{second}</tspan>}
                      </text>
                    </g>
                  );
                })}
              </g>
            ))}
          </svg>

          {plottedTrains.map(({ train, point }) => (
            <Ariakit.PopoverDisclosure
              aria-label={`${train.id}, ${formatDelay(train.delaySeconds, lang)}, ${captionForTrain(train, messages)}`}
              className="absolute z-10 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-[var(--background)] shadow-sm outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-primary"
              key={train.id}
              onClick={() => setSelected(train)}
              style={{ left: point.x, top: point.y, color: trainColor(train) }}
            >
              <TrainFront aria-hidden="true" className="size-5" strokeWidth={2.4} />
            </Ariakit.PopoverDisclosure>
          ))}
        </div>
      </div>

      <Ariakit.Popover
        className="z-[80] w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface-strong p-4 shadow-[var(--shadow-float)] outline-none"
        gutter={8}
        portal
        data-testid="train-detail"
      >
        {selected === null ? null : (
          <div>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="eyebrow">{selected.line.code} · {selected.id}</p>
                <p className="mt-1 text-2xl font-black">{formatDelay(selected.delaySeconds, lang)}</p>
                <p className="mt-1 text-xs text-muted">{captionForTrain(selected, messages)}</p>
              </div>
              <TrainFront aria-hidden="true" className="size-6 shrink-0" style={{ color: trainColor(selected) }} />
            </div>
            <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
              <div><dt className="text-muted">{messages.live.lastPositionUpdate}</dt><dd className="font-bold">{formatMadridTime(selected.sourceAt, lang, true)}</dd></div>
              <div><dt className="text-muted">{messages.live.nextArrival}</dt><dd className="font-bold">{formatMadridTime(selected.scheduledArrivalAt, lang, true)}</dd></div>
              <div><dt className="text-muted">{messages.live.probableArrival}</dt><dd className="font-bold">{formatMadridTime(selected.probableArrivalAt, lang, true)}</dd></div>
              <div><dt className="text-muted">{messages.common.state}</dt><dd className="font-bold">{evidenceLabel(selected.state, messages)}</dd></div>
              <div><dt className="text-muted">{messages.common.confidence}</dt><dd className="font-bold">{confidenceLabel(selected.position.confidence, messages)}</dd></div>
            </dl>
          </div>
        )}
      </Ariakit.Popover>
    </Ariakit.PopoverProvider>
  );
}
