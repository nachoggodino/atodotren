"use client";

import * as Ariakit from "@ariakit/react";
import type { Lang, SummaryStats } from "@/lib/domain/contracts";
import type { LiveStatusLevel } from "@/lib/domain/live-status";
import type { Messages } from "@/messages/types";
import { summaryMetricItems, type SummaryMetricKey } from "./summary-metrics";

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

export function LiveStatsBand({ stats, lang, messages }: { readonly stats: SummaryStats; readonly lang: Lang; readonly messages: Messages }) {
  const details: Record<SummaryMetricKey, { readonly help: string; readonly position: MetricPosition }> = {
    punctuality: { help: messages.live.punctualityHelp, position: "top-left" },
    coverage: { help: messages.live.coverageHelp, position: "top-right" },
    mean: { help: messages.live.meanHelp, position: "bottom-left" },
    median: { help: messages.live.medianHelp, position: "bottom-right" },
  };
  return (
    <div className="grid grid-cols-2 gap-px rounded-2xl bg-border" data-testid="live-stats-grid">
      {summaryMetricItems(stats, lang, messages).map((metric) => <LiveMetricCard {...metric} {...details[metric.key]} key={metric.key} />)}
    </div>
  );
}
