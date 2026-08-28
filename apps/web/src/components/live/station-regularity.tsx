import type { Lang, StationCadenceSummary } from "@/lib/domain/contracts";
import { formatCompactDelay, formatPercent } from "@/lib/domain/format";
import type { Messages } from "@/messages/types";

function duration(value: number | null, lang: Lang): string {
  return formatCompactDelay(value, lang).replace(/^\+/, "");
}

function regularityTone(value: number | null): string {
  if (value === null) return "var(--unknown)";
  if (value >= 0.85) return "var(--success)";
  if (value >= 0.65) return "var(--warning)";
  return "var(--danger)";
}

export function StationRegularity({ value, lang, messages }: { readonly value: StationCadenceSummary; readonly lang: Lang; readonly messages: Messages }) {
  const tone = regularityTone(value.regularity);
  return <div data-testid="station-regularity">
    <div className="grid grid-cols-2 border-y border-border">
      <div className="border-b border-r border-border px-3 py-4 text-center"><p className="text-[.7rem] font-bold uppercase tracking-wide text-muted">{messages.live.regularity}</p><strong className="metric-value mt-1 block text-2xl font-black">{formatPercent(value.regularity)}</strong></div>
      <div className="border-b border-border px-3 py-4 text-center"><p className="text-[.7rem] font-bold uppercase tracking-wide text-muted">{messages.live.medianCadenceDeviation}</p><strong className="metric-value mt-1 block text-2xl font-black">{duration(value.medianDeviationSeconds, lang)}</strong></div>
      <div className="border-r border-border px-3 py-4 text-center"><p className="text-[.7rem] font-bold uppercase tracking-wide text-muted">{messages.live.scheduledCadence}</p><strong className="metric-value mt-1 block text-xl font-black">{duration(value.medianScheduledHeadwaySeconds, lang)}</strong></div>
      <div className="px-3 py-4 text-center"><p className="text-[.7rem] font-bold uppercase tracking-wide text-muted">{messages.live.observedCadence}</p><strong className="metric-value mt-1 block text-xl font-black">{duration(value.medianObservedHeadwaySeconds, lang)}</strong></div>
    </div>
    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted-soft" aria-hidden="true"><div className="h-full rounded-full transition-[width]" style={{ backgroundColor: tone, width: `${Math.round((value.regularity ?? 0) * 100)}%` }} /></div>
    <p className="mt-2 text-xs text-muted">{messages.live.regularityHelp} {messages.history.sample}: {value.sample}.</p>
  </div>;
}
