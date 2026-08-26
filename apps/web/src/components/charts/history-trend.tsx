"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { HistoryPoint, Lang } from "@/lib/domain/contracts";
import { formatHistoryDate } from "@/lib/domain/format";
import type { Messages } from "@/messages/types";
import { CHART_LAYOUT } from "./config";

export function HistoryTrend({ points, lang, messages }: { readonly points: readonly HistoryPoint[]; readonly lang: Lang; readonly messages: Messages }) {
  const crossesYear = new Set(points.map((point) => point.date.slice(0, 4))).size > 1;
  const data = points.map((point) => ({
    date: formatHistoryDate(point.date, lang, crossesYear),
    rawDate: point.date,
    delay: point.meanDelaySeconds === null ? null : Math.round(point.meanDelaySeconds / 6) / 10,
  }));
  return <div>
    <div aria-hidden="true" style={{ height: CHART_LAYOUT.trendHeight }}><ResponsiveContainer width="100%" height="100%"><LineChart accessibilityLayer={false} data={data} margin={CHART_LAYOUT.margin}><CartesianGrid vertical={false} stroke="var(--border)" /><XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} /><YAxis axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} width={42} unit="m" /><Tooltip cursor={false} contentStyle={{ background: "var(--surface-strong)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)" }} /><Line type="monotone" dataKey="delay" stroke="var(--primary)" strokeWidth={3} dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></div>
    <div className="sr-only"><table><caption>{messages.charts.accessibleData}: {messages.charts.meanDelayTrend}</caption><thead><tr><th scope="col">{messages.charts.date}</th><th scope="col">{messages.charts.value}</th></tr></thead><tbody>{data.map((item) => <tr key={item.rawDate}><th scope="row">{item.rawDate}</th><td>{item.delay === null ? messages.common.noData : `${item.delay} min`}</td></tr>)}</tbody></table></div>
  </div>;
}
