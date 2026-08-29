"use client";

import * as Ariakit from "@ariakit/react";
import { TrainFront } from "lucide-react";
import type { Lang, StationUpcomingTrain } from "@/lib/domain/contracts";
import { formatCompactDelay, formatDelay, formatMadridTime } from "@/lib/domain/format";
import { delayStatusLevel } from "@/lib/domain/live-status";
import { lineSurfaceColor, MADRID_LINE_TEXT_COLOR } from "@/lib/domain/network";
import type { Messages } from "@/messages/types";

function remainingMinutes(arrivalAt: string | null, generatedAt: string, lang: Lang): string {
  if (arrivalAt === null) return "—";
  const remainingMs = Date.parse(arrivalAt) - Date.parse(generatedAt);
  if (!Number.isFinite(remainingMs)) return "—";
  const minutes = Math.max(0, Math.ceil(remainingMs / 60_000));
  return `${new Intl.NumberFormat(lang === "es" ? "es-ES" : "en-GB", { useGrouping: false }).format(minutes)} m`;
}

function stationDelay(delaySeconds: number | null, lang: Lang): string {
  return formatCompactDelay(delaySeconds, lang).replace(/^\+/, "");
}

function destinationLabel(train: StationUpcomingTrain, lang: Lang, messages: Messages): string {
  const station = train.destination ?? train.direction?.to;
  if (station != null) return station.name[lang];
  const headsign = train.headsign?.[lang] ?? train.direction?.headsign?.[lang];
  return headsign ?? messages.common.unavailable;
}

function DetailField({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt className="text-[8px] font-bold uppercase tracking-[.1em] text-muted">{label}</dt><dd className="mt-0.5 text-sm font-bold leading-tight">{value}</dd></div>;
}

function StationTrainRow({ train, generatedAt, lang, messages }: { readonly train: StationUpcomingTrain; readonly generatedAt: string; readonly lang: Lang; readonly messages: Messages }) {
  const station = train.currentStation ?? train.lastStoppedStation ?? train.previousStation;
  const arrivalAt = train.probableArrivalAt ?? train.scheduledArrivalAt;
  const eta = remainingMinutes(arrivalAt, generatedAt, lang);
  const destination = destinationLabel(train, lang, messages);
  const delayTone = delayStatusLevel(train.delaySeconds);
  return (
    <Ariakit.PopoverProvider placement="top">
      <Ariakit.PopoverDisclosure
        aria-label={`${train.id}, ${messages.live.towards} ${destination}, ${messages.live.arrivalIn} ${eta}`}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-4 py-4 text-left outline-none transition-[filter,transform] duration-100 hover:brightness-95 active:scale-[.99] focus-visible:ring-2 focus-visible:ring-foreground/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:px-5"
        data-testid="station-train-row"
        style={{ backgroundColor: lineSurfaceColor(train.line.slug), color: MADRID_LINE_TEXT_COLOR }}
        type="button"
      >
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-2">
            <strong className="shrink-0">{train.id}</strong>
            <span aria-hidden="true" className="opacity-60">·</span>
            <span className="truncate text-sm opacity-80">{station?.name[lang] ?? messages.live.positionUnavailable}</span>
          </span>
          <span className="live-tone mt-1 flex items-center gap-1.5 text-[.68rem] font-bold uppercase tracking-wide opacity-90" data-tone={delayTone}>
            <span aria-hidden="true" className="live-tone-dot size-[.55rem] shrink-0 rounded-full" />
            <span>{messages.live.delay}: {stationDelay(train.delaySeconds, lang)}</span>
          </span>
        </span>
        <span className="flex items-baseline justify-end gap-1 whitespace-nowrap">
          <span aria-hidden="true" className="text-[.68rem] font-bold opacity-75">{messages.live.arrivalPrefix}</span>
          <strong className="metric-value text-xl font-black tabular-nums sm:text-2xl">{eta}</strong>
        </span>
      </Ariakit.PopoverDisclosure>
      <Ariakit.Popover className="z-[80] w-[20rem] max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-surface-strong p-3 shadow-[var(--shadow-float)] outline-none" gutter={7} portal data-testid="station-train-detail">
        <div className="flex min-w-0 items-center gap-2">
          <TrainFront aria-hidden="true" className="size-5 shrink-0" style={{ color: train.line.color }} />
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-sm font-black">{train.id}</span>
            <span aria-hidden="true" className="text-xs text-muted">·</span>
            <span className="min-w-0 truncate text-xs font-semibold text-muted">{messages.live.towards} {destination}</span>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
          <DetailField label={messages.live.nextArrival} value={formatMadridTime(train.scheduledArrivalAt, lang, true)} />
          <DetailField label={messages.live.probableArrival} value={formatMadridTime(train.probableArrivalAt, lang, true)} />
          <DetailField label={messages.live.delay} value={formatDelay(train.delaySeconds, lang)} />
          <DetailField label={messages.live.lastObservedStop} value={train.lastStoppedStation?.name[lang] ?? messages.common.unavailable} />
        </dl>
      </Ariakit.Popover>
    </Ariakit.PopoverProvider>
  );
}

export function StationTrainList({ trains, generatedAt, lang, messages }: { readonly trains: readonly StationUpcomingTrain[]; readonly generatedAt: string; readonly lang: Lang; readonly messages: Messages }) {
  return <div className="mt-4 grid gap-3 px-1 sm:px-2">{trains.map((train) => <StationTrainRow generatedAt={generatedAt} key={`${train.journeyId}-${train.id}`} lang={lang} messages={messages} train={train} />)}</div>;
}
