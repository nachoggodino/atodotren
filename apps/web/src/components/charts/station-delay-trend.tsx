"use client";

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { StationDelayTrendPoint } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";
import { CHART_LAYOUT } from "./config";

function delayMinutes(seconds: number | null): number | null {
  return seconds === null ? null : Math.round(seconds / 6) / 10;
}

export function StationDelayTrend({ points, messages }: { readonly points: readonly StationDelayTrendPoint[]; readonly messages: Messages }) {
  if (points.length === 0) return <p className="border-y border-border py-6 text-sm text-muted">{messages.common.noData}</p>;
  const data = points.map((point) => ({ hour: `${String(point.hour).padStart(2, "0")}:00`, mean: delayMinutes(point.meanDelaySeconds), median: delayMinutes(point.medianDelaySeconds), sample: point.sample }));
  return <div>
    <div aria-hidden="true" style={{ height: CHART_LAYOUT.trendHeight }}><ResponsiveContainer width="100%" height="100%"><LineChart accessibilityLayer={false} data={data} margin={CHART_LAYOUT.margin}><CartesianGrid vertical={false} stroke="var(--border)" /><XAxis dataKey="hour" axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} /><YAxis axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} width={42} unit="m" /><Tooltip cursor={false} contentStyle={{ background: "var(--surface-strong)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)" }} /><Legend wrapperStyle={{ fontSize: 11 }} /><Line type="monotone" dataKey="mean" name={messages.common.mean} stroke="var(--primary)" strokeWidth={3} dot={{ r: 2.5 }} isAnimationActive={false} connectNulls /><Line type="monotone" dataKey="median" name={messages.common.median} stroke="var(--landing-highlight)" strokeWidth={2.5} strokeDasharray="5 4" dot={{ r: 2.5 }} isAnimationActive={false} connectNulls /></LineChart></ResponsiveContainer></div>
    <div className="sr-only"><table><caption>{messages.charts.accessibleData}: {messages.live.stationDelayTrend}</caption><thead><tr><th scope="col">{messages.history.hour}</th><th scope="col">{messages.common.mean}</th><th scope="col">{messages.common.median}</th><th scope="col">{messages.history.sample}</th></tr></thead><tbody>{data.map((item) => <tr key={item.hour}><th scope="row">{item.hour}</th><td>{item.mean === null ? messages.common.noData : `${item.mean} min`}</td><td>{item.median === null ? messages.common.noData : `${item.median} min`}</td><td>{item.sample}</td></tr>)}</tbody></table></div>
  </div>;
}
