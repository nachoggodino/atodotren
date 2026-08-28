import { BarChart3 } from "lucide-react";
import type { ReactNode } from "react";
import { DelayDistribution } from "@/components/charts/delay-distribution";
import { HistoryTrend } from "@/components/charts/history-trend";
import { DataMeta } from "@/components/feedback/data-meta";
import { StatsBand } from "@/components/live/stats-band";
import type { HistoryResponse, Lang } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";
import { HistoryInsights } from "./history-insights";
import { RankingList } from "./ranking-list";

export function HistoryLayout({ data, lang, messages, filterForm, matrix }: { readonly data: HistoryResponse; readonly lang: Lang; readonly messages: Messages; readonly filterForm: ReactNode; readonly matrix?: ReactNode }) {
  const finalizationNotice = data.meta.finalization.state === "processing"
    ? messages.history.currentDay
    : data.meta.finalization.state === "unknown"
      ? messages.history.finalizationUnknown
      : null;

  return (
    <div className="page-shell pb-20 pt-12">
      <div className="flex items-center gap-2"><BarChart3 aria-hidden="true" className="size-5 shrink-0 text-[var(--landing-highlight)]" data-testid="history-title-icon" /><p className="eyebrow">{messages.history.title}</p></div>
      <h1 className="mt-3 text-4xl font-black tracking-[-.05em] sm:text-6xl">{data.context.label}</h1>
      <div className="mt-6"><DataMeta meta={data.meta} lang={lang} messages={messages} /></div>
      <section className="mt-8"><h2 className="sr-only">{messages.history.filters}</h2>{filterForm}</section>
      {finalizationNotice === null ? null : <p className="mt-3 text-sm font-semibold text-warning">{finalizationNotice}</p>}
      <div className="mt-8"><StatsBand stats={data.stats} lang={lang} messages={messages} /></div>
      <p className="mt-2 text-xs text-muted">{messages.history.p90Help}</p>
      <section className="mt-12 grid gap-10 border-t border-border pt-8 lg:grid-cols-[1.15fr_.85fr]">
        <div><h2 className="text-2xl font-black">{messages.history.trend}</h2><div className="mt-4"><HistoryTrend points={data.trend} lang={lang} messages={messages} /></div></div>
        <div><h2 className="text-2xl font-black">{messages.history.distribution}</h2><div className="mt-4"><DelayDistribution values={data.stats.distribution} messages={messages} /></div></div>
      </section>
      {data.rankings.status === "unavailable" ? null : <section className="mt-12"><h2 className="text-2xl font-black">{messages.history.rankings}</h2><div className="mt-4"><RankingList ranking={data.rankings} lang={lang} messages={messages} /></div></section>}
      <HistoryInsights data={data} lang={lang} messages={messages} />
      {matrix === undefined ? null : <section className="mt-12 border-t border-border pt-8"><h2 className="text-2xl font-black">{messages.history.matrix}</h2><div className="mt-4">{matrix}</div></section>}
    </div>
  );
}
