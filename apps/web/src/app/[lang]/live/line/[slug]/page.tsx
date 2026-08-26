import { notFound } from "next/navigation";
import { DelayDistribution } from "@/components/charts/delay-distribution";
import { DataMeta } from "@/components/feedback/data-meta";
import { LiveHeader } from "@/components/live/live-header";
import { LiveRefresh } from "@/components/live/live-refresh";
import { SchematicMap } from "@/components/live/schematic-map";
import { StatsBand } from "@/components/live/stats-band";
import { formatDelay } from "@/lib/domain/format";
import { getMessages, isLang } from "@/lib/i18n";
import { getLiveLine } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export default async function LiveLinePage({ params, searchParams }: { readonly params: Promise<{ lang: string; slug: string }>; readonly searchParams: Promise<{ scenario?: string }> }) {
  const [{ lang, slug }, query] = await Promise.all([params, searchParams]);
  if (!isLang(lang)) notFound();
  const messages = getMessages(lang);
  const data = await getLiveLine(slug, query.scenario);
  if (data === null || !("code" in data.context)) notFound();
  const comparison = data.comparison;

  return (
    <div className="page-shell pb-20 pt-7 sm:pt-9">
      <LiveHeader title={messages.nav.live} subtitle={`${messages.common.line} ${data.context.name[lang]}`} serviceDate={data.meta.serviceDate} />
      <div className="mt-5">
        <DataMeta meta={data.meta} lang={lang} messages={messages} variant="live" />
        <LiveRefresh messages={messages} />
      </div>
      <div className="mt-6"><StatsBand stats={data.stats} lang={lang} messages={messages} /></div>
      <section className="mt-12">
        <div className="mb-4 flex items-baseline justify-between gap-4"><h2 className="text-2xl font-black">{messages.live.schematic}</h2><span className="text-sm text-muted">{data.trains.length} {messages.live.activeTrains}</span></div>
        {data.patterns.length === 0 ? <p className="border-y border-border py-8 text-muted">{messages.common.noData}</p> : <SchematicMap patterns={data.patterns} trains={data.trains} lineColor={data.context.color} lang={lang} messages={messages} />}
      </section>
      <section className="mt-12 grid gap-8 border-t border-border pt-8 lg:grid-cols-2">
        <div><h2 className="text-2xl font-black">{messages.history.distribution}</h2><DelayDistribution values={data.stats.distribution} messages={messages} /></div>
        <div><p className="eyebrow">{messages.live.comparison}</p>{comparison.status === "available" ? <><p className="metric-value mt-3 text-5xl font-black">{formatDelay(comparison.value.meanDelaySeconds, lang)}</p><p className="mt-2 text-sm text-muted">{messages.live.comparisonDescription} · {comparison.value.sample} {messages.history.sample}</p></> : <p className="mt-3 border-y border-border py-6 text-sm text-muted">{comparison.status === "insufficient-sample" ? messages.live.comparisonInsufficient : messages.live.comparisonUnavailable}</p>}</div>
      </section>
    </div>
  );
}
