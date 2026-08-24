"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHART } from "@/lib/design/tokens";
import type { HistoryPoint, Lang } from "@/lib/domain/contracts";

export function HistoryTrend({ points, lang }: { readonly points: readonly HistoryPoint[]; readonly lang: Lang }) {
  const data = points.map((point) => ({ date: point.date.slice(5), delay: point.meanDelaySeconds === null ? null : Math.round(point.meanDelaySeconds / 6) / 10, punctuality: point.punctuality === null ? null : Math.round(point.punctuality * 100) }));
  return <div className="h-[280px]" role="img" aria-label={lang === "es" ? "Evolución temporal del retraso medio" : "Mean delay trend"}><ResponsiveContainer width="100%" height="100%"><LineChart data={data} margin={CHART.margin}><CartesianGrid vertical={false} stroke="var(--border)" /><XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} /><YAxis axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} width={42} unit="m" /><Tooltip contentStyle={{ background: "var(--surface-strong)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)" }} /><Line type="monotone" dataKey="delay" stroke="var(--primary)" strokeWidth={3} dot={false} isAnimationActive animationDuration={CHART.animationMs} /></LineChart></ResponsiveContainer></div>;
}
