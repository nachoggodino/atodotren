import type { ReactNode } from "react";
import { DataMeta } from "@/components/feedback/data-meta";
import { DelayDistribution } from "@/components/charts/delay-distribution";
import { HistoryTrend } from "@/components/charts/history-trend";
import { RankingList } from "./ranking-list";
import { StatsBand } from "@/components/live/stats-band";
import type { HistoryResponse, Lang } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";

export function HistoryLayout({ data, lang, messages, filterForm, matrix }: { readonly data: HistoryResponse; readonly lang: Lang; readonly messages: Messages; readonly filterForm: ReactNode; readonly matrix?: ReactNode }) {
  return <div className="page-shell pb-20 pt-12"><p className="eyebrow">{messages.history.title}</p><h1 className="mt-3 text-4xl font-black tracking-[-.05em] sm:text-6xl">{data.context.label}</h1><div className="mt-6"><DataMeta meta={data.meta} lang={lang} messages={messages} /></div><section className="mt-8"><h2 className="sr-only">{messages.history.filters}</h2>{filterForm}</section>{!data.meta.finalized ? <p className="mt-3 text-sm font-semibold text-warning">{messages.history.currentDay}</p> : null}<div className="mt-8"><StatsBand stats={data.stats} lang={lang} messages={messages} /></div><section className="mt-12 grid gap-10 border-t border-border pt-8 lg:grid-cols-[1.15fr_.85fr]"><div><h2 className="text-2xl font-black">{messages.history.trend}</h2><div className="mt-4"><HistoryTrend points={data.trend} lang={lang} /></div></div><div><h2 className="text-2xl font-black">{messages.history.distribution}</h2><div className="mt-4"><DelayDistribution values={data.stats.distribution} lang={lang} /></div></div></section><section className="mt-12"><h2 className="text-2xl font-black">{messages.history.rankings}</h2><div className="mt-4"><RankingList items={data.rankings} lang={lang} messages={messages} /></div></section>{matrix === undefined ? null : <section className="mt-12 border-t border-border pt-8"><h2 className="text-2xl font-black">{messages.history.matrix}</h2><div className="mt-4">{matrix}</div></section>}</div>;
}
