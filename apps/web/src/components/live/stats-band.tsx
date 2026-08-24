import type { Lang, SummaryStats } from "@/lib/domain/contracts";
import { formatDelay, formatPercent } from "@/lib/domain/format";
import type { Messages } from "@/messages/types";

export function StatsBand({ stats, lang, messages }: { readonly stats: SummaryStats; readonly lang: Lang; readonly messages: Messages }) {
  const metrics = [
    [messages.common.punctuality, formatPercent(stats.punctuality)],
    [messages.common.mean, formatDelay(stats.meanDelaySeconds, lang)],
    [messages.common.median, formatDelay(stats.medianDelaySeconds, lang)],
    [messages.common.coverage, formatPercent(stats.scheduled === 0 ? null : stats.observed / stats.scheduled)],
  ] as const;
  return <dl className="grid grid-cols-2 gap-x-4 border-y border-border md:grid-cols-4">{metrics.map(([label, value]) => <div className="py-5 md:py-6" key={label}><dt className="text-xs font-bold uppercase tracking-wide text-muted">{label}</dt><dd className="metric-value mt-1 text-2xl font-black sm:text-3xl">{value}</dd></div>)}</dl>;
}
