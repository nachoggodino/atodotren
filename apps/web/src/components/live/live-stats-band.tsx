"use client";

import * as Ariakit from "@ariakit/react";
import type { Lang, SummaryStats } from "@/lib/domain/contracts";
import type { LiveStatusLevel } from "@/lib/domain/live-status";
import type { Messages } from "@/messages/types";
import { summaryMetricItems, type SummaryMetricKey } from "./summary-metrics";

type MetricPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type LiveStatsContext = "network" | "line" | "station";

function LiveMetricCard({ label, value, tone, help, position }: { readonly label: string; readonly value: string; readonly tone: LiveStatusLevel; readonly help: string; readonly position: MetricPosition }) {
  return (
    <Ariakit.PopoverProvider>
      <Ariakit.PopoverDisclosure className="live-stat-cell min-w-0 cursor-pointer px-4 py-5 text-center sm:px-5 sm:py-6" data-position={position} data-tone={tone} type="button">
        <span className="block text-[.68rem] font-bold uppercase tracking-wide">{label}</span>
        <strong className="metric-value mt-1 block text-xl font-black sm:text-2xl">{value}</strong>
      </Ariakit.PopoverDisclosure>
      <Ariakit.Popover className="z-[90] w-[min(20rem,calc(100vw-1.5rem))] rounded-xl border border-border bg-surface-strong p-4 text-foreground shadow-[var(--shadow-float)]" gutter={8}>
        <Ariakit.PopoverHeading className="text-sm font-black" render={<h2 />}>{label}</Ariakit.PopoverHeading>
        <Ariakit.PopoverDescription className="mt-2 text-sm leading-6 text-muted">{help}</Ariakit.PopoverDescription>
      </Ariakit.Popover>
    </Ariakit.PopoverProvider>
  );
}

function metricHelp(messages: Messages, context: LiveStatsContext): Record<SummaryMetricKey, string> {
  if (context === "line") {
    return {
      punctuality: messages.live.linePunctualityHelp,
      coverage: messages.live.lineCoverageHelp,
      mean: messages.live.lineMeanHelp,
      median: messages.live.lineMedianHelp,
    };
  }
  if (context === "station") {
    return {
      punctuality: messages.live.stationPunctualityHelp,
      coverage: messages.live.stationCoverageHelp,
      mean: messages.live.stationMeanHelp,
      median: messages.live.stationMedianHelp,
    };
  }
  return {
    punctuality: messages.live.punctualityHelp,
    coverage: messages.live.coverageHelp,
    mean: messages.live.meanHelp,
    median: messages.live.medianHelp,
  };
}

export function LiveStatsBand({ stats, lang, messages, context }: { readonly stats: SummaryStats; readonly lang: Lang; readonly messages: Messages; readonly context: LiveStatsContext }) {
  const help = metricHelp(messages, context);
  const positions: Record<SummaryMetricKey, MetricPosition> = {
    punctuality: "top-left",
    coverage: "top-right",
    mean: "bottom-left",
    median: "bottom-right",
  };
  return (
    <div className="grid grid-cols-2 gap-px rounded-2xl bg-border" data-testid="live-stats-grid">
      {summaryMetricItems(stats, lang, messages).map(({ key, ...metric }) => <LiveMetricCard {...metric} help={help[key]} position={positions[key]} key={key} />)}
    </div>
  );
}
