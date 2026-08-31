import type { ReactNode } from "react";
import { DelayDistribution } from "@/components/charts/delay-distribution";
import { HistoryTrend } from "@/components/charts/history-trend";
import { DataMeta } from "@/components/feedback/data-meta";
import { LiveHeader } from "@/components/live/live-header";
import { SummaryStatsCard } from "@/components/summary-stats-card";
import type { HistoryResponse, Lang } from "@/lib/domain/contracts";
import type { HistoryAnalysisContext, HistoryTrendPoint } from "@/lib/domain/history-analysis";
import { lineSurfaceColor } from "@/lib/domain/network";
import type { Messages } from "@/messages/types";
import { HistoryHeatmaps } from "./history-heatmaps";
import { HistoryInsights } from "./history-insights";
import { RankingList } from "./ranking-list";

export function HistoryLayout({
  data,
  trend,
  lang,
  messages,
  filterForm,
  matrix,
  scenario,
}: {
  readonly data: HistoryResponse;
  readonly trend: readonly HistoryTrendPoint[];
  readonly lang: Lang;
  readonly messages: Messages;
  readonly filterForm: ReactNode;
  readonly matrix?: ReactNode;
  readonly scenario?: string;
}) {
  const subtitle = data.context.kind === "network"
    ? messages.live.networkTitle
    : data.context.kind === "line"
      ? `${messages.common.line} ${data.context.label}`
      : data.context.label;
  const contextColor = data.context.kind === "line" && data.context.slug !== null
    ? lineSurfaceColor(data.context.slug.es)
    : undefined;
  const backLabel = data.context.kind === "network" ? undefined : messages.common.back;
  const help = {
    punctuality: messages.history.punctualityHelp,
    coverage: messages.history.coverageHelp,
    mean: messages.history.meanHelp,
    median: messages.history.medianHelp,
  } as const;
  const analysisContext: HistoryAnalysisContext = {
    kind: data.context.kind,
    key: data.context.kind === "line" ? data.context.slug?.es ?? data.context.id : data.context.id,
  };
  const fixedLineSlug = data.context.kind === "line" ? data.context.slug?.es ?? null : null;

  return (
    <div className="page-shell relative pb-20 pt-7 sm:pt-9">
      <LiveHeader
        {...(backLabel === undefined ? {} : { backLabel })}
        {...(contextColor === undefined ? {} : { contextColor })}
        lang={lang}
        messages={messages}
        mode="explore"
        subtitle={subtitle}
        title={messages.history.title}
      />
      <div className="mt-5"><DataMeta meta={data.meta} lang={lang} messages={messages} variant="explore" /></div>
      <section className="mt-6"><h2 className="sr-only">{messages.history.filters}</h2>{filterForm}</section>
      <div className="mt-6"><SummaryStatsCard help={help} lang={lang} messages={messages} stats={data.stats} testId="explore-stats-grid" /></div>

      <section className="mt-12 border-t border-border pt-8">
        <h2 className="text-2xl font-black">{messages.history.trend}</h2>
        <div className="mt-4"><HistoryTrend points={trend} lang={lang} messages={messages} /></div>
      </section>

      <section className="mt-12 border-t border-border pt-8">
        <h2 className="text-2xl font-black">{messages.history.distribution}</h2>
        <div className="mt-4 max-w-4xl"><DelayDistribution values={data.stats.distribution} messages={messages} /></div>
      </section>

      <HistoryHeatmaps
        context={analysisContext}
        filters={data.filters}
        fixedLineSlug={fixedLineSlug}
        initialDirections={data.context.kind === "line" ? data.directions : []}
        lang={lang}
        {...(scenario === undefined ? {} : { scenario })}
      />

      {data.rankings.status === "unavailable" ? null : <section className="mt-12"><h2 className="text-2xl font-black">{messages.history.rankings}</h2><div className="mt-4"><RankingList ranking={data.rankings} lang={lang} messages={messages} /></div></section>}
      <HistoryInsights data={data} lang={lang} messages={messages} />
      {matrix === undefined ? null : <section className="mt-12 border-t border-border pt-8"><h2 className="text-2xl font-black">{messages.history.matrix}</h2><div className="mt-4">{matrix}</div></section>}
    </div>
  );
}
