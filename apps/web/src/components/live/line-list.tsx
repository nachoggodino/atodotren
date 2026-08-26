import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { LineBadge } from "@/components/line-badge";
import type { Lang, LinePerformance } from "@/lib/domain/contracts";
import { formatDelay, formatPercent } from "@/lib/domain/format";
import { coverageStatusLevel, delayStatusLevel, punctualityStatusLevel } from "@/lib/domain/live-status";
import type { Messages } from "@/messages/types";

export function LineList({ lines, lang, messages }: { readonly lines: readonly LinePerformance[]; readonly lang: Lang; readonly messages: Messages }) {
  return (
    <div className="grid grid-cols-2 gap-3 px-1 sm:gap-4 sm:px-3" data-testid="live-line-grid">
      {lines.map((line) => {
        const stats = line.stats.status === "available" ? line.stats.value : null;
        const coverage = stats === null || stats.scheduled === 0 ? null : stats.observed / stats.scheduled;
        const metrics = [
          { label: messages.common.punctuality, value: formatPercent(stats?.punctuality ?? null), tone: punctualityStatusLevel(stats?.punctuality ?? null) },
          { label: messages.common.coverage, value: formatPercent(coverage), tone: coverageStatusLevel(coverage) },
          { label: messages.common.mean, value: formatDelay(stats?.meanDelaySeconds ?? null, lang), tone: delayStatusLevel(stats?.meanDelaySeconds ?? null) },
          { label: messages.common.median, value: formatDelay(stats?.medianDelaySeconds ?? null, lang), tone: delayStatusLevel(stats?.medianDelaySeconds ?? null) },
        ] as const;

        return (
          <Link
            className="group min-w-0 rounded-xl border border-border bg-surface/40 p-2.5 transition-[transform,background-color,border-color] hover:bg-muted-soft/60 active:scale-[.97] active:bg-muted-soft sm:p-3"
            href={`/${lang}/live/line/${line.slug}`}
            key={line.id}
          >
            <div className="grid min-w-0 grid-cols-[auto_1fr_auto] items-center gap-1.5 sm:gap-2">
              <LineBadge className="size-8 text-[.68rem] sm:size-9 sm:text-xs" code={line.code} color={line.color} />
              <span className="min-w-0 whitespace-nowrap text-[.55rem] font-semibold tracking-[-.01em] text-muted sm:text-xs">{line.activeTrains} {messages.live.activeTrains}</span>
              <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-active:translate-x-1" />
            </div>
            <span className="mt-3 grid grid-cols-2 gap-x-2 gap-y-2">
              {metrics.map(({ label, value, tone }) => (
                <span aria-label={`${label}: ${value}`} className="live-line-metric min-w-0" data-testid="live-line-metric" data-tone={tone} key={label}>
                  <strong className="metric-value text-[.68rem] leading-4 sm:text-xs">{value}</strong>
                </span>
              ))}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
