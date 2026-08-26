import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { lineBadgeTextColor } from "@/components/line-badge";
import type { Lang, LinePerformance } from "@/lib/domain/contracts";
import { formatDelay, formatPercent } from "@/lib/domain/format";
import { coverageStatusLevel, delayStatusLevel, punctualityStatusLevel } from "@/lib/domain/live-status";
import type { Messages } from "@/messages/types";

function formatLineDelay(seconds: number | null, lang: Lang): string {
  return formatDelay(seconds, lang).replace(" min ", " m ");
}

export function LineList({ lines, lang, messages }: { readonly lines: readonly LinePerformance[]; readonly lang: Lang; readonly messages: Messages }) {
  return (
    <div className="grid grid-cols-2 gap-3 px-1 sm:gap-4 sm:px-3" data-testid="live-line-grid">
      {lines.map((line) => {
        const stats = line.stats.status === "available" ? line.stats.value : null;
        const coverage = stats === null || stats.scheduled === 0 ? null : stats.observed / stats.scheduled;
        const metrics = [
          { label: messages.common.punctuality, value: formatPercent(stats?.punctuality ?? null), tone: punctualityStatusLevel(stats?.punctuality ?? null) },
          { label: messages.common.coverage, value: formatPercent(coverage), tone: coverageStatusLevel(coverage) },
          { label: messages.common.mean, value: formatLineDelay(stats?.meanDelaySeconds ?? null, lang), tone: delayStatusLevel(stats?.meanDelaySeconds ?? null) },
          { label: messages.common.median, value: formatLineDelay(stats?.medianDelaySeconds ?? null, lang), tone: delayStatusLevel(stats?.medianDelaySeconds ?? null) },
        ] as const;
        const lineTextColor = lineBadgeTextColor(line.color);

        return (
          <Link
            className="group min-w-0 rounded-xl border border-border bg-surface/40 p-2.5 transition-[transform,background-color,border-color] hover:bg-muted-soft/60 active:scale-[.97] active:bg-muted-soft sm:p-3"
            href={`/${lang}/live/line/${line.slug}`}
            key={line.id}
          >
            <div
              className="flex h-8 min-w-0 items-center justify-between rounded-md px-2.5 text-[.6rem] font-bold tracking-[-.01em] sm:h-9 sm:text-xs"
              data-testid="live-line-header"
              style={{ backgroundColor: line.color, color: lineTextColor }}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <strong className="shrink-0 text-[.72rem] font-black sm:text-sm">{line.code}</strong>
                <span aria-hidden="true" className="opacity-70">•</span>
                <span className="min-w-0 whitespace-nowrap">{line.activeTrains} {messages.live.activeTrains}</span>
              </span>
              <ChevronRight aria-hidden="true" className="-mr-1 ml-3 size-5 shrink-0 transition-transform group-hover:translate-x-0.5 group-active:translate-x-1" />
            </div>
            <span className="mt-3 grid grid-cols-2 gap-x-2 gap-y-2">
              {metrics.map(({ label, value, tone }) => (
                <span aria-label={`${label}: ${value}`} className="live-line-metric min-w-0" data-testid="live-line-metric" data-tone={tone} key={label}>
                  <strong className="metric-value whitespace-nowrap text-[.68rem] leading-4 sm:text-xs">{value}</strong>
                </span>
              ))}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
