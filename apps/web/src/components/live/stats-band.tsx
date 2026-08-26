import type { Lang, SummaryStats } from "@/lib/domain/contracts";
import { formatDelay, formatPercent } from "@/lib/domain/format";
import { coverageStatusLevel, delayStatusLevel, punctualityStatusLevel } from "@/lib/domain/live-status";
import type { Messages } from "@/messages/types";

export function StatsBand({ stats, lang, messages }: { readonly stats: SummaryStats; readonly lang: Lang; readonly messages: Messages }) {
  const coverage = stats.scheduled === 0 ? null : stats.observed / stats.scheduled;
  const metrics = [
    { label: messages.common.punctuality, value: formatPercent(stats.punctuality), tone: punctualityStatusLevel(stats.punctuality) },
    { label: messages.common.mean, value: formatDelay(stats.meanDelaySeconds, lang), tone: delayStatusLevel(stats.meanDelaySeconds) },
    { label: messages.common.median, value: formatDelay(stats.medianDelaySeconds, lang), tone: delayStatusLevel(stats.medianDelaySeconds) },
    { label: messages.common.coverage, value: formatPercent(coverage), tone: coverageStatusLevel(coverage) },
  ] as const;

  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border" data-testid="live-stats-grid">
      {metrics.map(({ label, value, tone }) => (
        <div className="live-stat-cell min-w-0 px-4 py-5 sm:px-5 sm:py-6" data-tone={tone} key={label}>
          <dt className="text-[.68rem] font-bold uppercase tracking-wide">{label}</dt>
          <dd className="metric-value mt-1 text-xl font-black sm:text-2xl">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
