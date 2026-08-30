"use client";

import { useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { historyAnalysisCopy } from "@/components/history/history-analysis-copy";
import type { Lang } from "@/lib/domain/contracts";
import { formatHistoryDate } from "@/lib/domain/format";
import type { HistoryTrendPoint } from "@/lib/domain/history-analysis";
import type { Messages } from "@/messages/types";
import { CHART_LAYOUT } from "./config";

type TrendMetric = "punctuality" | "mean" | "median" | "delayedStops";

const METRICS: readonly TrendMetric[] = ["punctuality", "mean", "median", "delayedStops"];

function metricValue(point: HistoryTrendPoint, metric: TrendMetric): number | null {
  if (metric === "punctuality") return point.punctuality === null ? null : Math.round(point.punctuality * 1000) / 10;
  if (metric === "mean") return point.meanDelaySeconds === null ? null : Math.round(point.meanDelaySeconds / 6) / 10;
  if (metric === "median") return point.medianDelaySeconds === null ? null : Math.round(point.medianDelaySeconds / 6) / 10;
  return point.delayedStops;
}

export function HistoryTrend({ points, lang, messages }: { readonly points: readonly HistoryTrendPoint[]; readonly lang: Lang; readonly messages: Messages }) {
  const [metric, setMetric] = useState<TrendMetric>("mean");
  const copy = historyAnalysisCopy(lang);
  const crossesYear = new Set(points.map((point) => point.date.slice(0, 4))).size > 1;
  const unit = metric === "punctuality" ? "%" : metric === "delayedStops" ? "" : "m";
  const label = copy.trendMetrics[metric];
  const data = points.map((point) => ({
    date: formatHistoryDate(point.date, lang, crossesYear),
    rawDate: point.date,
    value: metricValue(point, metric),
  }));

  return <div data-testid="explore-trend">
    <div className="mb-4 flex w-fit max-w-full flex-wrap gap-1 rounded-xl border border-border bg-surface-strong p-1" role="radiogroup" aria-label={messages.history.trend}>
      {METRICS.map((option) => (
        <button
          aria-checked={metric === option}
          className="h-7 rounded-lg px-2.5 text-[11px] font-bold leading-none transition-[background-color,color,transform] active:scale-95 aria-checked:bg-[var(--landing-highlight)] aria-checked:text-[var(--background)]"
          key={option}
          onClick={() => setMetric(option)}
          role="radio"
          type="button"
        >
          {copy.trendMetrics[option]}
        </button>
      ))}
    </div>
    <div aria-hidden="true" style={{ height: CHART_LAYOUT.trendHeight }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart accessibilityLayer={false} data={data} margin={CHART_LAYOUT.margin}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} />
          <YAxis
            axisLine={false}
            {...(metric === "punctuality" ? { domain: [0, 100] as [number, number] } : {})}
            tickLine={false}
            tick={{ fill: "var(--muted)", fontSize: 11 }}
            width={46}
            unit={unit}
          />
          <Tooltip cursor={false} contentStyle={{ background: "var(--surface-strong)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)" }} formatter={(value) => [`${String(value)}${unit}`, label]} />
          <Line type="monotone" dataKey="value" name={label} stroke="var(--primary)" strokeWidth={3} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
    <div className="sr-only"><table><caption>{messages.charts.accessibleData}: {label}</caption><thead><tr><th scope="col">{messages.charts.date}</th><th scope="col">{messages.charts.value}</th></tr></thead><tbody>{data.map((item) => <tr key={item.rawDate}><th scope="row">{item.rawDate}</th><td>{item.value === null ? messages.common.noData : `${item.value}${unit}`}</td></tr>)}</tbody></table></div>
  </div>;
}
