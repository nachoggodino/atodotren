import type { Lang, SummaryStats } from "@/lib/domain/contracts";
import { formatDelay } from "@/lib/domain/format";
import type { Messages } from "@/messages/types";
import { summaryMetricItems } from "./summary-metrics";

export function StatsBand({ stats, lang, messages }: { readonly stats: SummaryStats; readonly lang: Lang; readonly messages: Messages }) {
  const historyMetrics = [
    ...summaryMetricItems(stats, lang, messages).map(({ label, value }) => ({ label, value })),
    { label: messages.common.p90, value: formatDelay(stats.p90DelaySeconds, lang) },
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 border-y border-border md:grid-cols-5">
      {historyMetrics.map(({ label, value }) => <div className="py-5 md:py-6" key={label}><dt className="text-xs font-bold uppercase tracking-wide text-muted">{label}</dt><dd className="metric-value mt-1 text-2xl font-black sm:text-3xl">{value}</dd></div>)}
    </dl>
  );
}
