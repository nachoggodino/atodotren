import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { LineBadge } from "@/components/line-badge";
import type { Lang, LinePerformance } from "@/lib/domain/contracts";
import { formatDelay, formatPercent } from "@/lib/domain/format";
import type { Messages } from "@/messages/types";

export function LineList({ lines, lang, messages }: { readonly lines: readonly LinePerformance[]; readonly lang: Lang; readonly messages: Messages }) {
  return <div className="divide-y divide-border border-y border-border">{lines.map((line) => {
    const stats = line.stats.status === "available" ? line.stats.value : null;
    return <Link className="grid grid-cols-[auto_1fr_auto] items-center gap-4 py-4 hover:bg-muted-soft/50 sm:grid-cols-[auto_1fr_repeat(3,minmax(6rem,auto))_auto]" href={`/${lang}/live/line/${line.slug}`} key={line.id}><LineBadge code={line.code} color={line.color} /><span><strong className="block">{line.name[lang]}</strong><span className="text-xs text-muted">{line.activeTrains} {messages.live.activeTrains}</span></span><span className="hidden text-right sm:block"><small className="block text-muted">{messages.common.punctuality}</small><strong>{formatPercent(stats?.punctuality ?? null)}</strong></span><span className="hidden text-right sm:block"><small className="block text-muted">{messages.common.mean}</small><strong>{formatDelay(stats?.meanDelaySeconds ?? null, lang)}</strong></span><span className="hidden text-right sm:block"><small className="block text-muted">{messages.common.coverage}</small><strong>{stats === null ? "—" : formatPercent(stats.scheduled === 0 ? null : stats.observed / stats.scheduled)}</strong></span><ArrowRight className="size-4 text-muted" /></Link>;
  })}</div>;
}
