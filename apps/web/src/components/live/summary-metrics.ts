import type { Lang, SummaryStats } from "@/lib/domain/contracts";
import { formatCompactDelay, formatDelay, formatPercent } from "@/lib/domain/format";
import { coverageStatusLevel, delayStatusLevel, punctualityStatusLevel, type LiveStatusLevel } from "@/lib/domain/live-status";
import type { Messages } from "@/messages/types";

export type SummaryMetricKey = "punctuality" | "coverage" | "mean" | "median";

export interface SummaryMetricItem {
  readonly key: SummaryMetricKey;
  readonly label: string;
  readonly value: string;
  readonly tone: LiveStatusLevel;
}

export function summaryMetricItems(stats: SummaryStats | null, lang: Lang, messages: Messages, compactDelay = false): readonly SummaryMetricItem[] {
  const coverage = stats === null || stats.scheduled === 0 ? null : stats.observed / stats.scheduled;
  const delayFormatter = compactDelay ? formatCompactDelay : formatDelay;
  return [
    { key: "punctuality", label: messages.common.punctuality, value: formatPercent(stats?.punctuality ?? null), tone: punctualityStatusLevel(stats?.punctuality ?? null) },
    { key: "coverage", label: messages.common.coverage, value: formatPercent(coverage), tone: coverageStatusLevel(coverage) },
    { key: "mean", label: messages.common.mean, value: delayFormatter(stats?.meanDelaySeconds ?? null, lang), tone: delayStatusLevel(stats?.meanDelaySeconds ?? null) },
    { key: "median", label: messages.common.median, value: delayFormatter(stats?.medianDelaySeconds ?? null, lang), tone: delayStatusLevel(stats?.medianDelaySeconds ?? null) },
  ];
}
