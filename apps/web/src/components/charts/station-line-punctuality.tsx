"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { StationLinePunctuality } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";
import { CHART_LAYOUT } from "./config";

export function StationLinePunctualityChart({ values, messages }: { readonly values: readonly StationLinePunctuality[]; readonly messages: Messages }) {
  if (values.length === 0) return <p className="border-y border-border py-6 text-sm text-muted">{messages.common.noData}</p>;
  const data = values.map((item) => ({ code: item.line.code, punctuality: item.punctuality === null ? null : Math.round(item.punctuality * 1000) / 10, sample: item.sample, color: item.line.color }));
  return <div>
    <div aria-hidden="true" style={{ height: CHART_LAYOUT.distributionHeight }}><ResponsiveContainer width="100%" height="100%"><BarChart accessibilityLayer={false} data={data} margin={CHART_LAYOUT.distributionMargin}><CartesianGrid vertical={false} stroke="var(--border)" /><XAxis dataKey="code" axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11, fontWeight: 700 }} /><YAxis axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} width={48} domain={[0, 100]} unit="%" /><Tooltip cursor={false} contentStyle={{ background: "var(--surface-strong)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)" }} /><Bar dataKey="punctuality" name={messages.common.punctuality} unit="%" radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false}>{data.map((item) => <Cell fill={item.color} key={item.code} />)}</Bar></BarChart></ResponsiveContainer></div>
    <div className="sr-only"><table><caption>{messages.charts.accessibleData}: {messages.live.stationLinePunctuality}</caption><thead><tr><th scope="col">{messages.common.line}</th><th scope="col">{messages.common.punctuality}</th><th scope="col">{messages.history.sample}</th></tr></thead><tbody>{data.map((item) => <tr key={item.code}><th scope="row">{item.code}</th><td>{item.punctuality === null ? messages.common.noData : `${item.punctuality}%`}</td><td>{item.sample}</td></tr>)}</tbody></table></div>
  </div>;
}
