import { notFound } from "next/navigation";
import { DataMeta } from "@/components/feedback/data-meta";
import { DelayDistribution } from "@/components/charts/delay-distribution";
import { LiveRefresh } from "@/components/live/live-refresh";
import { SchematicMap } from "@/components/live/schematic-map";
import { StatsBand } from "@/components/live/stats-band";
import { getMessages, isLang } from "@/lib/i18n";
import { getLiveLine } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export default async function LiveLinePage({ params, searchParams }: { readonly params: Promise<{ lang: string; slug: string }>; readonly searchParams: Promise<{ scenario?: string }> }) {
  const [{ lang, slug }, query] = await Promise.all([params, searchParams]); if (!isLang(lang)) notFound(); const messages = getMessages(lang); const data = await getLiveLine(slug, query.scenario); if (data === null || !("code" in data.context)) notFound();
  return <div className="page-shell pb-20 pt-12"><p className="eyebrow">{messages.live.title} · {data.context.code}</p><h1 className="mt-3 text-4xl font-black tracking-[-.05em] sm:text-6xl">{data.context.name[lang]}</h1><div className="mt-6"><DataMeta meta={data.meta} lang={lang} messages={messages} /><LiveRefresh lang={lang} messages={messages} /></div><div className="mt-8"><StatsBand stats={data.stats} lang={lang} messages={messages} /></div><section className="mt-12"><div className="mb-4 flex items-baseline justify-between gap-4"><h2 className="text-2xl font-black">{messages.live.schematic}</h2><span className="text-sm text-muted">{data.trains.length} {messages.live.trains.toLowerCase()}</span></div>{data.stops.length === 0 ? <p className="border-y border-border py-8 text-muted">{messages.common.noData}</p> : <SchematicMap stops={data.stops} trains={data.trains} lineColor={data.context.color} lang={lang} messages={messages} />}</section><section className="mt-12 grid gap-8 border-t border-border pt-8 lg:grid-cols-2"><div><h2 className="text-2xl font-black">{messages.history.distribution}</h2><DelayDistribution values={data.stats.distribution} lang={lang} /></div><div><p className="eyebrow">{messages.live.comparison}</p><p className="metric-value mt-3 text-5xl font-black">{data.comparison.meanDelaySeconds === null ? "—" : `${Math.round(data.comparison.meanDelaySeconds / 60)} min`}</p><p className="mt-2 text-sm text-muted">{lang === "es" ? "Media para el mismo día de semana y franja cuando hay muestra suficiente." : "Mean for the same weekday/hour when sufficient evidence exists."}</p></div></section></div>;
}
