import { notFound } from "next/navigation";
import { DataMeta } from "@/components/feedback/data-meta";
import { DelayDistribution } from "@/components/charts/delay-distribution";
import { LineList } from "@/components/live/line-list";
import { LiveRefresh } from "@/components/live/live-refresh";
import { StatsBand } from "@/components/live/stats-band";
import { getMessages, isLang } from "@/lib/i18n";
import { getLiveNetwork } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export default async function LivePage({ params, searchParams }: { readonly params: Promise<{ lang: string }>; readonly searchParams: Promise<{ scenario?: string }> }) {
  const [{ lang }, query] = await Promise.all([params, searchParams]); if (!isLang(lang)) notFound(); const messages = getMessages(lang); const data = await getLiveNetwork(query.scenario);
  return <div className="page-shell pb-20 pt-12"><p className="eyebrow">{messages.live.title}</p><div className="mt-3 flex flex-wrap items-end justify-between gap-4"><h1 className="text-4xl font-black tracking-[-.045em] sm:text-5xl">{messages.live.networkTitle}</h1><span className="text-sm text-muted">{data.meta.serviceDate}</span></div><div className="mt-6"><DataMeta meta={data.meta} lang={lang} messages={messages} /><LiveRefresh lang={lang} messages={messages} /></div><div className="mt-8"><StatsBand stats={data.stats} lang={lang} messages={messages} /></div><section className="mt-12"><h2 className="text-2xl font-black tracking-tight">{messages.live.networkTitle}</h2><div className="mt-4"><LineList lines={data.lines} lang={lang} /></div></section><section className="mt-12 grid gap-8 border-t border-border pt-8 lg:grid-cols-[.8fr_1.2fr]"><div><p className="eyebrow">{messages.history.distribution}</p><h2 className="mt-2 text-2xl font-black">{lang === "es" ? "Cómo se reparte el retraso de hoy" : "How today’s delay is distributed"}</h2><p className="mt-3 text-sm leading-6 text-muted">{lang === "es" ? "La distribución usa únicamente observaciones con retraso utilizable; cobertura y ausencias se muestran por separado." : "The distribution uses observations with usable delay only; coverage and missing evidence remain separate."}</p></div><DelayDistribution values={data.stats.distribution} lang={lang} /></section></div>;
}
