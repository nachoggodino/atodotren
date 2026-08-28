"use client";

import * as Ariakit from "@ariakit/react";
import { TrainFront } from "lucide-react";
import { LineBadge } from "@/components/line-badge";
import type { Lang, TrainDetail } from "@/lib/domain/contracts";
import { formatCompactDelay, formatDelay, formatMadridTime } from "@/lib/domain/format";
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

function destinationLabel(train: TrainDetail, lang: Lang, messages: Messages): string {
  const station = train.destination ?? train.direction?.to;
  if (station != null) return station.name[lang];
  const headsign = train.headsign?.[lang] ?? train.direction?.headsign?.[lang];
  return headsign ?? messages.common.unavailable;
}

function DetailField({ label, value, className = "" }: { readonly label: string; readonly value: string; readonly className?: string }) {
  return <div className={className}><dt className="text-[8px] font-bold uppercase tracking-[.1em] text-muted">{label}</dt><dd className="mt-0.5 text-sm font-bold leading-tight">{value}</dd></div>;
}

function StationTrainRow({ train, generatedAt, lang, messages }: { readonly train: TrainDetail; readonly generatedAt: string; readonly lang: Lang; readonly messages: Messages }) {
  const station = train.currentStation ?? train.previousStation;
  const arrivalAt = train.probableArrivalAt ?? train.scheduledArrivalAt;
  const eta = remainingMinutes(arrivalAt, generatedAt, lang);
  const destination = destinationLabel(train, lang, messages);
  return (
    <Ariakit.PopoverProvider placement="top">
      <Ariakit.PopoverDisclosure
        aria-label={`${train.id}, ${messages.live.towards} ${destination}, ${messages.live.arrivalIn} ${eta}`}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 bg-transparent px-3 py-4 text-left text-foreground outline-none transition-[background-color,transform] duration-100 hover:bg-muted-soft active:scale-[.99] active:bg-muted-soft focus-visible:z-10 focus-visible:rounded-md sm:px-4"
        data-testid="station-train-row"
        type="button"
      >
        <LineBadge code={train.line.code} color={train.line.color} variant="station" />
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-2">
            <strong className="shrink-0">{train.id}</strong>
            <span aria-hidden="true" className="text-muted">·</span>
            <span className="truncate text-sm text-muted">{station?.name[lang] ?? messages.live.positionUnavailable}</span>
          </span>
          <span className="mt-1 block text-[.68rem] font-bold uppercase tracking-wide text-muted">{messages.live.delay}: {stationDelay(train.delaySeconds, lang)}</span>
        </span>
        <span className="flex items-baseline justify-end gap-1 whitespace-nowrap">
          <span aria-hidden="true" className="text-[.68rem] font-bold text-muted">{messages.live.arrivalPrefix}</span>
          <strong className="metric-value text-xl font-black tabular-nums sm:text-2xl">{eta}</strong>
        </span>
      </Ariakit.PopoverDisclosure>
      <Ariakit.Popover className="z-[80] w-[20rem] max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-surface-strong p-3 shadow-[var(--shadow-float)] outline-none" gutter={7} portal data-testid="station-train-detail">
        <div className="flex min-w-0 items-center gap-2">
          <LineBadge code={train.line.code} color={train.line.color} variant="compact" />
          <div className="min-w-0"><div className="flex min-w-0 items-baseline gap-1.5"><TrainFront aria-hidden="true" className="size-4 shrink-0" style={{ color: train.line.color }} /><span className="shrink-0 text-sm font-black">{train.id}</span><span aria-hidden="true" className="text-xs text-muted">·</span><span className="min-w-0 truncate text-xs font-semibold text-muted">{messages.live.towards} {destination}</span></div></div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
          <DetailField label={messages.live.nextArrival} value={formatMadridTime(train.scheduledArrivalAt, lang, true)} />
          <DetailField label={messages.live.probableArrival} value={formatMadridTime(train.probableArrivalAt, lang, true)} />
          <DetailField label={messages.live.delay} value={formatDelay(train.delaySeconds, lang)} />
          <DetailField label={messages.live.lastPositionUpdate} value={formatMadridTime(train.sourceAt, lang, true)} />
        </dl>
      </Ariakit.Popover>
    </Ariakit.PopoverProvider>
  );
}

export function StationTrainList({ trains, generatedAt, lang, messages }: { readonly trains: readonly TrainDetail[]; readonly generatedAt: string; readonly lang: Lang; readonly messages: Messages }) {
  return <div className="mt-4 divide-y divide-border border-y border-border">{trains.map((train) => <StationTrainRow generatedAt={generatedAt} key={`${train.journeyId}-${train.id}`} lang={lang} messages={messages} train={train} />)}</div>;
}
