"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DelayBucket } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";
import { CHART_LAYOUT } from "./config";

function boundaryMinutes(seconds: number): number {
  return Math.floor(seconds / 60);
}

function bucketLabel(bucket: DelayBucket, messages: Messages): string {
  if (bucket.id === "early") return messages.charts.early;
  if (bucket.id === "punctual") return messages.charts.punctual;
  if (bucket.minSeconds === null) return messages.common.noData;
  const lower = boundaryMinutes(Math.max(0, bucket.minSeconds - 1));
  if (bucket.maxSeconds === null) return `>${lower}m`;
  return `${lower}–${boundaryMinutes(bucket.maxSeconds)}m`;
}

export function DelayDistribution({ values, messages }: { readonly values: readonly DelayBucket[]; readonly messages: Messages }) {
  const data = values.map((bucket) => ({ label: bucketLabel(bucket, messages), value: bucket.count }));
  return <div>
    <div aria-hidden="true" className="w-full" style={{ height: CHART_LAYOUT.distributionHeight }}><ResponsiveContainer width="100%" height="100%"><BarChart accessibilityLayer={false} data={data} margin={CHART_LAYOUT.distributionMargin}><CartesianGrid vertical={false} stroke="var(--border)" /><XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} /><YAxis axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} width={52} /><Tooltip cursor={false} contentStyle={{ background: "var(--surface-strong)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)" }} /><Bar dataKey="value" fill="var(--primary)" name={messages.charts.calls} radius={[4, 4, 0, 0]} isAnimationActive={false} /></BarChart></ResponsiveContainer></div>
    <div className="sr-only"><table><caption>{messages.charts.accessibleData}: {messages.charts.delayDistribution}</caption><thead><tr><th scope="col">{messages.history.distribution}</th><th scope="col">{messages.charts.calls}</th></tr></thead><tbody>{data.map((item) => <tr key={item.label}><th scope="row">{item.label}</th><td>{item.value}</td></tr>)}</tbody></table></div>
  </div>;
}
