import type { Capability, HistoryResponse, HourWeekdayItem, Lang, SegmentDelayItem, VolumeReliabilityItem } from "@/lib/domain/contracts";
import { formatDelay, formatPercent } from "@/lib/domain/format";
import { delayStatusLevel } from "@/lib/domain/live-status";
import type { Messages } from "@/messages/types";
import { RankingList } from "./ranking-list";

function CapabilityMessage({ capability, messages }: { readonly capability: Capability<readonly unknown[]>; readonly messages: Messages }) {
  return <p className="border-y border-border py-6 text-sm text-muted">{capability.status === "insufficient-sample" ? messages.history.insufficient : messages.history.rankingsUnavailable}</p>;
}

function SegmentList({ capability, lang, messages }: { readonly capability: Capability<readonly SegmentDelayItem[]>; readonly lang: Lang; readonly messages: Messages }) {
  if (capability.status !== "available") return <CapabilityMessage capability={capability} messages={messages} />;
  return <ol className="divide-y divide-border border-y border-border">{capability.value.map((item) => <li className="grid grid-cols-[1fr_auto] items-center gap-4 py-3" key={item.id}><span><strong className="block">{item.label}</strong><small className="text-muted">{item.direction === 0 ? messages.common.directionA : messages.common.directionB} · {item.sample} {messages.history.sample}</small></span><strong className="metric-value text-right">{formatDelay(item.addedDelaySeconds, lang)}</strong></li>)}</ol>;
}

function VolumeReliability({ capability, lang, messages }: { readonly capability: Capability<readonly VolumeReliabilityItem[]>; readonly lang: Lang; readonly messages: Messages }) {
  if (capability.status !== "available") return <CapabilityMessage capability={capability} messages={messages} />;
  return <div className="overflow-x-auto border-y border-border"><table className="w-full min-w-[34rem] border-collapse text-sm"><thead><tr className="text-left text-xs uppercase tracking-wide text-muted"><th className="py-3 pr-4">{messages.common.details}</th><th className="px-3 py-3 text-right">{messages.history.scheduledVolume}</th><th className="px-3 py-3 text-right">{messages.common.coverage}</th><th className="px-3 py-3 text-right">{messages.common.punctuality}</th><th className="py-3 pl-3 text-right">{messages.common.mean}</th></tr></thead><tbody className="divide-y divide-border">{capability.value.map((item) => <tr key={item.id}><th className="py-3 pr-4 text-left font-bold">{item.label}</th><td className="px-3 py-3 text-right tabular-nums">{item.scheduled}</td><td className="px-3 py-3 text-right tabular-nums">{formatPercent(item.coverage)} <small className="block text-muted">n={item.sample}</small></td><td className="px-3 py-3 text-right tabular-nums">{formatPercent(item.punctuality)}</td><td className="py-3 pl-3 text-right font-bold">{formatDelay(item.meanDelaySeconds, lang)}</td></tr>)}</tbody></table></div>;
}

function weekdayLabels(messages: Messages): readonly string[] {
  return [messages.history.sunday, messages.history.monday, messages.history.tuesday, messages.history.wednesday, messages.history.thursday, messages.history.friday, messages.history.saturday];
}

function HourWeekdayHeatmap({ capability, lang, messages }: { readonly capability: Capability<readonly HourWeekdayItem[]>; readonly lang: Lang; readonly messages: Messages }) {
  if (capability.status !== "available") return <CapabilityMessage capability={capability} messages={messages} />;
  const byCell = new Map(capability.value.map((item) => [`${item.weekday}:${item.hour}`, item]));
  const weekdays = weekdayLabels(messages);
  return <div className="overflow-x-auto" data-testid="history-hour-weekday"><div className="grid min-w-[46rem] gap-px bg-border" style={{ gridTemplateColumns: "3.5rem repeat(7, minmax(5.5rem, 1fr))" }}><span className="bg-surface-strong" />{weekdays.map((weekday) => <strong className="bg-surface-strong px-2 py-2 text-center text-xs" key={weekday}>{weekday.slice(0, 3)}</strong>)}{Array.from({ length: 24 }, (_, hour) => [<strong className="bg-surface-strong px-2 py-3 text-right text-xs tabular-nums" key={`hour-${hour}`}>{String(hour).padStart(2, "0")}:00</strong>, ...weekdays.map((_, weekday) => { const item = byCell.get(`${weekday}:${hour}`); if (item === undefined) return <span className="bg-surface px-2 py-3 text-center text-xs text-muted" key={`${weekday}-${hour}`}>—</span>; return <span className="live-stat-cell px-2 py-2 text-center" data-tone={delayStatusLevel(item.meanDelaySeconds)} key={`${weekday}-${hour}`} title={`${item.sample} ${messages.history.sample} · ${formatPercent(item.coverage)} ${messages.common.coverage}`}><strong className="block text-xs">{formatDelay(item.meanDelaySeconds, lang)}</strong><small className="block text-[10px] text-muted">{formatPercent(item.coverage)} · n={item.sample}</small></span>; })])}</div></div>;
}

export function HistoryInsights({ data, lang, messages }: { readonly data: HistoryResponse; readonly lang: Lang; readonly messages: Messages }) {
  const showStations = data.context.kind !== "station";
  const showSegments = data.context.kind === "line";
  const showVolumePrimary = data.context.kind === "station";
  return <><section className="mt-12 grid gap-10 border-t border-border pt-8 lg:grid-cols-2">{showStations ? <div><h2 className="text-2xl font-black">{messages.history.stationRanking}</h2><div className="mt-4"><RankingList ranking={data.insights.stations} lang={lang} messages={messages} /></div></div> : null}<div><h2 className="text-2xl font-black">{messages.history.worstHours}</h2><div className="mt-4"><RankingList ranking={data.insights.hours} lang={lang} messages={messages} /></div></div>{showSegments ? <div className="lg:col-span-2"><h2 className="text-2xl font-black">{messages.history.segmentDelay}</h2><p className="mt-2 max-w-3xl text-sm text-muted">{messages.history.segmentDelayHelp}</p><div className="mt-4"><SegmentList capability={data.insights.segments} lang={lang} messages={messages} /></div></div> : null}{showVolumePrimary ? <div><h2 className="text-2xl font-black">{messages.history.volumeReliability}</h2><p className="mt-2 text-sm text-muted">{messages.history.volumeReliabilityHelp}</p><div className="mt-4"><VolumeReliability capability={data.insights.volumeReliability} lang={lang} messages={messages} /></div></div> : null}</section><details className="mt-12 border-y border-border py-1"><summary className="cursor-pointer py-4 text-lg font-black">{messages.history.secondaryAnalysis}</summary><div className="grid gap-10 pb-8 pt-4"><section><h2 className="text-xl font-black">{messages.history.hourWeekday}</h2><div className="mt-4"><HourWeekdayHeatmap capability={data.insights.hourWeekday} lang={lang} messages={messages} /></div></section>{showVolumePrimary ? null : <section><h2 className="text-xl font-black">{messages.history.volumeReliability}</h2><p className="mt-2 max-w-3xl text-sm text-muted">{messages.history.volumeReliabilityHelp}</p><div className="mt-4"><VolumeReliability capability={data.insights.volumeReliability} lang={lang} messages={messages} /></div></section>}</div></details></>;
}
