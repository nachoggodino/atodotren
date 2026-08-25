import type { Capability, Lang, RankingItem } from "@/lib/domain/contracts";
import { formatDelay, formatPercent } from "@/lib/domain/format";
import type { Messages } from "@/messages/types";

export function RankingList({ ranking, lang, messages }: { readonly ranking: Capability<readonly RankingItem[]>; readonly lang: Lang; readonly messages: Messages }) {
  if (ranking.status === "unavailable") return <p className="border-y border-border py-6 text-sm text-muted">{messages.history.rankingsUnavailable}</p>;
  if (ranking.status === "insufficient-sample" || ranking.value.length === 0) return <p className="border-y border-border py-6 text-sm text-muted">{messages.history.insufficient}</p>;
  return <ol className="divide-y divide-border border-y border-border">{ranking.value.map((item, index) => <li className="grid grid-cols-[2rem_1fr_auto] items-center gap-3 py-3" key={item.id}><span className="text-sm font-black text-muted">{index + 1}</span><span><strong>{item.label}</strong><small className="ml-2 text-muted">{item.sample} {messages.history.sample}</small></span><span className="text-right"><strong className="metric-value block">{formatDelay(item.meanDelaySeconds, lang)}</strong><small className="text-muted">{formatPercent(item.punctuality)}</small></span></li>)}</ol>;
}
