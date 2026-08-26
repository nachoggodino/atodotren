import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { LineBadge } from "@/components/line-badge";
import type { Lang, LinePerformance } from "@/lib/domain/contracts";
import { formatDelay, formatPercent } from "@/lib/domain/format";
import type { Messages } from "@/messages/types";

export function LineList({ lines, lang, messages }: { readonly lines: readonly LinePerformance[]; readonly lang: Lang; readonly messages: Messages }) {
  return (
    <div className="grid grid-cols-2 gap-3 px-1 sm:gap-4 sm:px-3" data-testid="live-line-grid">
      {lines.map((line) => {
        const stats = line.stats.status === "available" ? line.stats.value : null;
        const coverage = stats === null || stats.scheduled === 0 ? null : stats.observed / stats.scheduled;
        const metrics = [
          [messages.common.punctuality, formatPercent(stats?.punctuality ?? null)],
          [messages.common.mean, formatDelay(stats?.meanDelaySeconds ?? null, lang)],
          [messages.common.coverage, formatPercent(coverage)],
        ] as const;

        return (
          <Link className="min-w-0 rounded-xl border border-border bg-surface/40 p-3 transition-colors hover:bg-muted-soft/60" href={`/${lang}/live/line/${line.slug}`} key={line.id}>
            <div className="flex min-w-0 items-start gap-2">
              <LineBadge className="size-9 text-xs sm:size-10 sm:text-sm" code={line.code} color={line.color} />
              <span className="min-w-0 flex-1">
                <strong className="block text-sm leading-5 sm:text-base">{line.name[lang]}</strong>
                <span className="block text-[.65rem] leading-4 text-muted sm:text-xs">{line.activeTrains} {messages.live.activeTrains}</span>
              </span>
              <ArrowRight aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-muted" />
            </div>
            <span className="mt-3 grid grid-cols-3 gap-1 border-t border-border pt-2">
              {metrics.map(([label, value]) => (
                <span className="min-w-0 text-center" key={label}>
                  <small className="block text-[.56rem] font-semibold uppercase leading-tight tracking-[.03em] text-muted sm:text-[.62rem]">{label}</small>
                  <strong className="metric-value mt-1 block text-xs sm:text-sm">{value}</strong>
                </span>
              ))}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
