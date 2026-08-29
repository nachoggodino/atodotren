"use client";

import * as Ariakit from "@ariakit/react";
import type { Lang, SummaryStats } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";
import { summaryMetricItems, type SummaryMetricKey } from "./live/summary-metrics";

type MetricPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type SummaryMetricHelp = Readonly<Record<SummaryMetricKey, string>>;

const POSITIONS: Readonly<Record<SummaryMetricKey, MetricPosition>> = {
  punctuality: "top-left",
  coverage: "top-right",
  mean: "bottom-left",
  median: "bottom-right",
};

function MetricCard({ label, value, tone, help, position }: ReturnType<typeof summaryMetricItems>[number] & { readonly help: string; readonly position: MetricPosition }) {
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

export function SummaryStatsCard({ stats, lang, messages, help, testId }: { readonly stats: SummaryStats; readonly lang: Lang; readonly messages: Messages; readonly help: SummaryMetricHelp; readonly testId: string }) {
  return (
    <div className="grid grid-cols-2 gap-px rounded-2xl bg-border" data-testid={testId}>
      {summaryMetricItems(stats, lang, messages).map((metric) => <MetricCard {...metric} help={help[metric.key]} position={POSITIONS[metric.key]} key={metric.key} />)}
    </div>
  );
}
