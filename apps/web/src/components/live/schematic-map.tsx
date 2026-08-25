"use client";

import { X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Lang, SchematicStop, TrainDetail } from "@/lib/domain/contracts";
import { delayBand, evidenceLabel, formatDelay } from "@/lib/domain/format";
import type { Messages } from "@/messages/types";

function trainPoint(train: TrainDetail, stops: readonly SchematicStop[]): { x: number; y: number } | null {
  const byId = new Map(stops.map((stop) => [stop.station.id, stop]));
  if (train.position.kind === "at_station" && train.position.stationId !== null) { const stop = byId.get(train.position.stationId); return stop === undefined ? null : { x: stop.x, y: stop.y }; }
  if (train.position.kind === "between_stations" && train.position.fromStationId !== null && train.position.toStationId !== null) {
    const from = byId.get(train.position.fromStationId); const to = byId.get(train.position.toStationId); if (from === undefined || to === undefined) return null; const progress = train.position.progress ?? .5; return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress };
  }
  return null;
}

function formatTime(value: string | null, lang: Lang): string { return value === null ? "—" : new Intl.DateTimeFormat(lang === "es" ? "es-ES" : "en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Europe/Madrid" }).format(new Date(value)); }

export function SchematicMap({ stops, trains, lineColor, lang, messages }: { readonly stops: readonly SchematicStop[]; readonly trains: readonly TrainDetail[]; readonly lineColor: string; readonly lang: Lang; readonly messages: Messages }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = trains.find((train) => train.id === selectedId) ?? null;
  const width = Math.max(720, (stops.at(-1)?.x ?? 680) + 90);
  const plotted = useMemo(() => trains.map((train) => ({ train, point: trainPoint(train, stops) })).filter((item): item is { train: TrainDetail; point: { x: number; y: number } } => item.point !== null), [trains, stops]);
  return <div>
    <div className="overflow-x-auto rounded-xl border border-border bg-surface-strong" data-testid="schematic-map"><svg aria-label={messages.live.schematic} className="min-h-[240px]" role="group" viewBox={`0 0 ${width} 250`} width={width} height="250">
      <path d={stops.map((stop, index) => `${index === 0 ? "M" : "L"}${stop.x} ${stop.y}`).join(" ")} fill="none" stroke={lineColor} strokeLinecap="round" strokeLinejoin="round" strokeWidth="10" opacity=".86" />
      {stops.map((stop) => <g key={stop.station.id}><circle cx={stop.x} cy={stop.y} r="8" fill="var(--surface-strong)" stroke={lineColor} strokeWidth="4" /><text x={stop.x} y={stop.y + 29} textAnchor="middle" fill="var(--foreground)" fontSize="11" fontWeight="700">{stop.station.name[lang].slice(0, 20)}</text></g>)}
      {plotted.map(({ train, point }) => { const band = delayBand(train.delaySeconds); const fill = band === "punctual" ? "var(--success)" : band === "mild" ? "var(--warning)" : band === "delayed" ? "var(--accent)" : band === "severe" ? "var(--danger)" : "var(--unknown)"; return <g key={train.id} role="button" tabIndex={0} aria-label={`${train.id}, ${formatDelay(train.delaySeconds, lang)}`} onClick={() => setSelectedId(train.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(train.id); } }} className="cursor-pointer"><rect x={point.x - 17} y={point.y - 35} width="34" height="23" rx="7" fill={fill} stroke="var(--surface-strong)" strokeWidth="3" /><circle cx={point.x - 8} cy={point.y - 15} r="3" fill="var(--surface-strong)" /><circle cx={point.x + 8} cy={point.y - 15} r="3" fill="var(--surface-strong)" /></g>; })}
    </svg></div>
    <p className="mt-2 text-xs text-muted">{messages.live.inferred}</p>
    {selected ? <aside className="mt-4 rounded-xl border border-border bg-surface-strong p-4" aria-label={`${messages.common.details}: ${selected.id}`} data-testid="train-detail"><div className="flex items-start justify-between gap-3"><div><p className="eyebrow">{selected.line.code} · {selected.id}</p><p className="mt-1 text-2xl font-black">{formatDelay(selected.delaySeconds, lang)}</p></div><button className="grid size-10 place-items-center rounded-md hover:bg-muted-soft" onClick={() => setSelectedId(null)} aria-label={messages.nav.close} type="button"><X className="size-4" /></button></div><dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted">{messages.live.nextArrival}</dt><dd className="font-bold">{formatTime(selected.scheduledArrivalAt, lang)}</dd></div><div><dt className="text-muted">{messages.live.probableArrival}</dt><dd className="font-bold">{formatTime(selected.probableArrivalAt, lang)}</dd></div><div><dt className="text-muted">{messages.live.sourceArrival}</dt><dd className="font-bold">{formatTime(selected.renfeReportedArrivalAt, lang)}</dd></div><div><dt className="text-muted">{messages.live.observedPresence}</dt><dd className="font-bold">{formatTime(selected.observedPresenceAt, lang)}</dd></div><div><dt className="text-muted">{messages.common.state}</dt><dd className="font-bold">{evidenceLabel(selected.state, lang)}</dd></div><div><dt className="text-muted">{messages.common.confidence}</dt><dd className="font-bold">{selected.position.confidence}</dd></div></dl>{selected.position.basis === "feed-inferred" ? <p className="mt-4 border-t border-border pt-3 text-xs font-semibold text-warning">{messages.live.inferred}</p> : null}</aside> : null}
  </div>;
}
