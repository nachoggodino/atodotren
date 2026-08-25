"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { LandingDelayPoint, Lang } from "@/lib/domain/contracts";
import { formatDuration, formatMadridTime } from "@/lib/domain/format";
import type { Messages } from "@/messages/types";

export function LandingDelayTrend({ points, lang, messages }: { readonly points: readonly LandingDelayPoint[]; readonly lang: Lang; readonly messages: Messages }) {
  const data = points.map((point) => ({
    at: point.at,
    time: formatMadridTime(point.at, lang),
    delay: point.totalDelaySeconds,
  }));
  const ticks = data.filter((_, index) => index % 8 === 0 || index === data.length - 1).map((point) => point.time);
  return <div>
    <div className="h-48 sm:h-56" role="img" aria-label={messages.landing.delayTrend}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="time" ticks={ticks} axisLine={false} tickLine={false} tick={{ fill: "var(--muted)", fontSize: 11 }} />
          <YAxis axisLine={false} tickLine={false} width={42} tick={{ fill: "var(--muted)", fontSize: 11 }} tickFormatter={(value) => `${Math.round(Number(value) / 3600)}h`} />
          <Tooltip contentStyle={{ background: "var(--surface-strong)", border: "1px solid var(--border)", borderRadius: 12, color: "var(--foreground)" }} formatter={(value) => [formatDuration(Number(value ?? 0), lang), messages.landing.todayDelay]} />
          <Area type="monotone" dataKey="delay" stroke="var(--landing-delay)" fill="var(--landing-delay)" fillOpacity={0.14} strokeWidth={3} dot={false} connectNulls={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
    <table className="sr-only"><caption>{messages.charts.accessibleData}: {messages.landing.delayTrend}</caption><thead><tr><th scope="col">{messages.charts.date}</th><th scope="col">{messages.charts.value}</th></tr></thead><tbody>{data.map((point) => <tr key={point.at}><th scope="row">{point.time}</th><td>{point.delay === null ? messages.common.noData : formatDuration(point.delay, lang)}</td></tr>)}</tbody></table>
  </div>;
}
