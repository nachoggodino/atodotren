"use client";

import * as Ariakit from "@ariakit/react";
import type { Lang, SummaryStats } from "@/lib/domain/contracts";
import { formatDelay, formatPercent } from "@/lib/domain/format";
import { coverageStatusLevel, delayStatusLevel, punctualityStatusLevel, type LiveStatusLevel } from "@/lib/domain/live-status";
import type { Messages } from "@/messages/types";

type MetricPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

function LiveMetricCard({ label, value, tone, help, position }: { readonly label: string; readonly value: string; readonly tone: LiveStatusLevel; readonly help: string; readonly position: MetricPosition }) {
  return (
    <Ariakit.PopoverProvider>
      <Ariakit.PopoverDisclosure className="live-stat-cell min-w-0 cursor-pointer px-4 py-5 text-left sm:px-5 sm:py-6" data-position={position} data-tone={tone} type="button">
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

export function StatsBand({ stats, lang, messages, variant = "default" }: { readonly stats: SummaryStats; readonly lang: Lang; readonly messages: Messages; readonly variant?: "default" | "live" }) {
  const coverage = stats.scheduled === 0 ? null : stats.observed / stats.scheduled;
  const liveMetrics = [
    { label: messages.common.punctuality, value: formatPercent(stats.punctuality), tone: punctualityStatusLevel(stats.punctuality), help: messages.live.punctualityHelp, position: "top-left" as const },
    { label: messages.common.coverage, value: formatPercent(coverage), tone: coverageStatusLevel(coverage), help: messages.live.coverageHelp, position: "top-right" as const },
    { label: messages.common.mean, value: formatDelay(stats.meanDelaySeconds, lang), tone: delayStatusLevel(stats.meanDelaySeconds), help: messages.live.meanHelp, position: "bottom-left" as const },
    { label: messages.common.median, value: formatDelay(stats.medianDelaySeconds, lang), tone: delayStatusLevel(stats.medianDelaySeconds), help: messages.live.medianHelp, position: "bottom-right" as const },
  ] as const;

  if (variant === "live") {
    return <div className="grid grid-cols-2 gap-px rounded-2xl bg-border" data-testid="live-stats-grid">{liveMetrics.map((metric) => <LiveMetricCard {...metric} key={metric.label} />)}</div>;
  }

  const historyMetrics = [
    { label: messages.common.punctuality, value: formatPercent(stats.punctuality) },
    { label: messages.common.coverage, value: formatPercent(coverage) },
    { label: messages.common.mean, value: formatDelay(stats.meanDelaySeconds, lang) },
    { label: messages.common.median, value: formatDelay(stats.medianDelaySeconds, lang) },
    { label: messages.common.p90, value: formatDelay(stats.p90DelaySeconds, lang) },
  ] as const;
  return (
    <dl className="grid grid-cols-2 gap-x-4 border-y border-border md:grid-cols-5">
      {historyMetrics.map(({ label, value }) => <div className="py-5 md:py-6" key={label}><dt className="text-xs font-bold uppercase tracking-wide text-muted">{label}</dt><dd className="metric-value mt-1 text-2xl font-black sm:text-3xl">{value}</dd></div>)}
    </dl>
  );
}
