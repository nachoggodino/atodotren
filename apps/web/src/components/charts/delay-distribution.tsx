"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHART } from "@/lib/design/tokens";
import type { Lang } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";

export function DelayDistribution({ values, lang, messages }: { readonly values: readonly number[]; readonly lang: Lang; readonly messages: Messages }) {
  const six = values.length === 72 ? [values[0] ?? 0, values.slice(1, 15).reduce((a, b) => a + b, 0), values.slice(15, 25).reduce((a, b) => a + b, 0), values.slice(25, 35).reduce((a, b) => a + b, 0), values.slice(35, 45).reduce((a, b) => a + b, 0), values.slice(45).reduce((a, b) => a + b, 0)] : [...values.slice(0, 6)];
  while (six.length < 6) six.push(0);
  const labels = [messages.charts.early, "≤2m", "2–5m", "5–10m", "10–15m", ">15m"];
  const data = labels.map((label, index) => ({ label, value: six[index] ?? 0 }));
  return <div className="h-[260px] w-full" role="img" aria-label={messages.charts.delayDistribution}><ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={CHART.margin}><CartesianGrid vertical={false} stroke="var(--border)" /><XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} /><YAxis axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} width={42} /><Tooltip cursor={{ fill: "var(--muted-soft)" }} contentStyle={{ background: "var(--surface-strong)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)" }} /><Bar dataKey="value" fill="var(--primary)" radius={[4, 4, 0, 0]} isAnimationActive animationDuration={CHART.animationMs} /></BarChart></ResponsiveContainer></div>;
}
