"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DelayBucket } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";
import { CHART_LAYOUT } from "./config";

function bucketLabel(bucket: DelayBucket, messages: Messages): string {
  switch (bucket.id) {
    case "early": return messages.charts.early;
    case "punctual": return messages.charts.punctual;
    case "delay-2-5": return "2–5m";
    case "delay-5-10": return "5–10m";
    case "delay-10-15": return "10–15m";
    case "delay-15-plus": return ">15m";
  }
}

export function DelayDistribution({ values, messages }: { readonly values: readonly DelayBucket[]; readonly messages: Messages }) {
  const data = values.map((bucket) => ({ label: bucketLabel(bucket, messages), value: bucket.count }));
  return <div>
    <div className="w-full" style={{ height: CHART_LAYOUT.distributionHeight }} role="img" aria-label={messages.charts.delayDistribution}><ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={CHART_LAYOUT.margin}><CartesianGrid vertical={false} stroke="var(--border)" /><XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} /><YAxis axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} width={42} /><Tooltip cursor={{ fill: "var(--muted-soft)" }} contentStyle={{ background: "var(--surface-strong)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)" }} /><Bar dataKey="value" fill="var(--primary)" radius={[4, 4, 0, 0]} isAnimationActive={false} /></BarChart></ResponsiveContainer></div>
    <table className="sr-only"><caption>{messages.charts.accessibleData}: {messages.charts.delayDistribution}</caption><thead><tr><th scope="col">{messages.history.distribution}</th><th scope="col">{messages.charts.value}</th></tr></thead><tbody>{data.map((item) => <tr key={item.label}><th scope="row">{item.label}</th><td>{item.value}</td></tr>)}</tbody></table>
  </div>;
}
