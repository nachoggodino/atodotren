"use client";

import { X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Lang, SchematicPattern, TrainDetail } from "@/lib/domain/contracts";
import { delayBand } from "@/lib/domain/delay-policy";
import { formatDelay, formatMadridTime } from "@/lib/domain/format";
import { layoutSchematicPatterns, pointForTrain, schematicHeight, schematicWidth } from "@/lib/domain/schematic";
import { positionCaptionKey } from "@/lib/domain/train";
import { confidenceLabel, directionLabel, evidenceLabel } from "@/lib/i18n/domain-labels";
import type { Messages } from "@/messages/types";

function captionForTrain(train: TrainDetail, messages: Messages): string {
  switch (positionCaptionKey(train.position)) {
    case "reported": return messages.live.reported;
    case "inferred": return messages.live.inferred;
    case "unavailable": return messages.live.positionUnavailable;
  }
}

function trainFill(train: TrainDetail): string {
  switch (delayBand(train.delaySeconds)) {
    case "punctual": return "var(--success)";
    case "mild": return "var(--warning)";
    case "delayed": return "var(--accent)";
    case "severe": return "var(--danger)";
    case "unknown": return "var(--unknown)";
  }
}

function stationLabel(value: string): readonly [string, string | null] {
  if (value.length <= 21) return [value, null];
  const split = value.lastIndexOf(" ", 21);
  if (split < 8) return [`${value.slice(0, 20)}…`, null];
  const first = value.slice(0, split);
  const rest = value.slice(split + 1);
  return [first, rest.length > 22 ? `${rest.slice(0, 21)}…` : rest];
}

export function SchematicMap({ patterns, trains, lineColor, lang, messages }: { readonly patterns: readonly SchematicPattern[]; readonly trains: readonly TrainDetail[]; readonly lineColor: string; readonly lang: Lang; readonly messages: Messages }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = trains.find((train) => train.id === selectedId) ?? null;
  const plottedPatterns = useMemo(() => layoutSchematicPatterns(patterns), [patterns]);
  const plottedTrains = useMemo(() => trains.map((train) => ({ train, point: pointForTrain(train, plottedPatterns) })), [trains, plottedPatterns]);
  const width = schematicWidth(plottedPatterns);
  const height = schematicHeight(plottedPatterns);
  const unplaced = plottedTrains.filter((item) => item.point === null);

  return <div>
    <div className="overflow-x-auto rounded-xl border border-border bg-surface-strong" data-testid="schematic-map"><svg aria-label={messages.live.schematic} className="min-h-[240px]" role="group" viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
      {plottedPatterns.map(({ pattern, stops }) => <g key={pattern.id}>
        <text x="22" y={(stops[0]?.y ?? 72) - 30} fill="var(--muted)" fontSize="10" fontWeight="700">{directionLabel(pattern.direction, lang, messages)}</text>
        <path d={stops.map((stop, index) => `${index === 0 ? "M" : "L"}${stop.x} ${stop.y}`).join(" ")} fill="none" stroke={lineColor} strokeLinecap="round" strokeLinejoin="round" strokeWidth="10" opacity=".86" />
        {stops.map((stop) => { const [first, second] = stationLabel(stop.station.name[lang]); return <g key={`${pattern.id}-${stop.station.id}`}><circle cx={stop.x} cy={stop.y} r="8" fill="var(--surface-strong)" stroke={lineColor} strokeWidth="4" /><text x={stop.x} y={stop.y + 28} textAnchor="middle" fill="var(--foreground)" fontSize="11" fontWeight="700"><tspan x={stop.x}>{first}</tspan>{second === null ? null : <tspan x={stop.x} dy="13">{second}</tspan>}</text></g>; })}
      </g>)}
      {plottedTrains.flatMap(({ train, point }) => point === null ? [] : [<g key={train.id} role="button" tabIndex={0} aria-label={`${train.id}, ${formatDelay(train.delaySeconds, lang)}, ${captionForTrain(train, messages)}`} onClick={() => setSelectedId(train.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(train.id); } }} className="cursor-pointer outline-none focus-visible:[&>rect]:stroke-primary"><rect x={point.x - 17} y={point.y - 35} width="34" height="23" rx="7" fill={trainFill(train)} stroke="var(--surface-strong)" strokeWidth="3" /><circle cx={point.x - 8} cy={point.y - 15} r="3" fill="var(--surface-strong)" /><circle cx={point.x + 8} cy={point.y - 15} r="3" fill="var(--surface-strong)" /></g>])}
    </svg></div>
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {trains.some((train) => positionCaptionKey(train.position) === "reported") ? <span>{messages.live.reported}</span> : null}
      {trains.some((train) => positionCaptionKey(train.position) === "inferred") ? <span>{messages.live.inferred}</span> : null}
      {unplaced.length > 0 ? <span>{messages.live.positionUnavailable}: {unplaced.length}</span> : null}
    </div>
    {unplaced.length === 0 ? null : <div className="mt-3 flex flex-wrap gap-2" aria-label={messages.live.positionUnavailable}>{unplaced.map(({ train }) => <button className="rounded-md border border-border px-3 py-2 text-xs font-bold hover:bg-muted-soft" key={train.id} onClick={() => setSelectedId(train.id)} type="button">{train.id} · {captionForTrain(train, messages)}</button>)}</div>}
    {selected ? <aside className="mt-4 rounded-xl border border-border bg-surface-strong p-4" aria-label={`${messages.common.details}: ${selected.id}`} data-testid="train-detail"><div className="flex items-start justify-between gap-3"><div><p className="eyebrow">{selected.line.code} · {selected.id}</p><p className="mt-1 text-2xl font-black">{formatDelay(selected.delaySeconds, lang)}</p><p className="mt-1 text-xs text-muted">{captionForTrain(selected, messages)}</p></div><button className="grid size-10 place-items-center rounded-md hover:bg-muted-soft" onClick={() => setSelectedId(null)} aria-label={messages.nav.close} type="button"><X className="size-4" /></button></div><dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted">{messages.live.nextArrival}</dt><dd className="font-bold">{formatMadridTime(selected.scheduledArrivalAt, lang, true)}</dd></div><div><dt className="text-muted">{messages.live.probableArrival}</dt><dd className="font-bold">{formatMadridTime(selected.probableArrivalAt, lang, true)}</dd></div><div><dt className="text-muted">{messages.live.sourceArrival}</dt><dd className="font-bold">{formatMadridTime(selected.renfeReportedArrivalAt, lang, true)}</dd></div><div><dt className="text-muted">{messages.live.observedPresence}</dt><dd className="font-bold">{formatMadridTime(selected.observedPresenceAt, lang, true)}</dd></div><div><dt className="text-muted">{messages.common.state}</dt><dd className="font-bold">{evidenceLabel(selected.state, messages)}</dd></div><div><dt className="text-muted">{messages.common.confidence}</dt><dd className="font-bold">{confidenceLabel(selected.position.confidence, messages)}</dd></div></dl></aside> : null}
  </div>;
}
