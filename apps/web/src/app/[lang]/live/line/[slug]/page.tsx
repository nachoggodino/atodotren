import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DelayDistribution } from "@/components/charts/delay-distribution";
import { DataMeta } from "@/components/feedback/data-meta";
import { LiveHeader } from "@/components/live/live-header";
import { LiveLineVisualization } from "@/components/live/live-line-visualization";
import { LiveRefresh } from "@/components/live/live-refresh";
import { StatsBand } from "@/components/live/stats-band";
import { formatDelay } from "@/lib/domain/format";
import { getMessages, isLang } from "@/lib/i18n";
import { localizedPageMetadata, sharedLocalizedPath } from "@/lib/seo";
import { getLiveLine, getMatrix } from "@/lib/server/services";
import { contextDescription, metadataCopy } from "@/messages/metadata";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { readonly params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLang(lang)) return {};
  const copy = metadataCopy[lang];
  const context = slug.toUpperCase();
  return localizedPageMetadata({ lang, paths: sharedLocalizedPath(`/live/line/${slug}`), title: `${context} · ${copy.liveNetworkTitle}`, description: contextDescription(copy.liveLineDescription, context) });
}

export default async function LiveLinePage({ params, searchParams }: { readonly params: Promise<{ lang: string; slug: string }>; readonly searchParams: Promise<{ scenario?: string }> }) {
  const [{ lang, slug }, query] = await Promise.all([params, searchParams]);
  if (!isLang(lang)) notFound();
  const messages = getMessages(lang);
  const data = await getLiveLine(slug, query.scenario);
  if (data === null || !("code" in data.context)) notFound();
  const comparison = data.comparison;
  const matrixResult = data.meta.serviceDate === null ? null : await getMatrix(slug, data.meta.serviceDate, query.scenario);

  return (
    <div className="page-shell pb-20 pt-7 sm:pt-9">
      <LiveHeader backLabel={messages.common.back} contextColor={data.context.color} subtitle={`${messages.common.line} ${data.context.name[lang]}`} title={messages.nav.live} />
      <div className="mt-5"><DataMeta meta={data.meta} lang={lang} messages={messages} variant="live" /><LiveRefresh messages={messages} /></div>
      <div className="mt-6"><StatsBand stats={data.stats} lang={lang} messages={messages} variant="live" /></div>
      <section className="mt-9"><LiveLineVisualization patterns={data.patterns} trains={data.trains} matrixResult={matrixResult} lineColor={data.context.color} lang={lang} messages={messages} /></section>
      <section className="mt-10 grid gap-8 border-t border-border pt-8 lg:grid-cols-2">
        <div><h2 className="text-2xl font-black">{messages.history.distribution}</h2><DelayDistribution values={data.stats.distribution} messages={messages} /></div>
        <div><p className="eyebrow">{messages.live.comparison}</p>{comparison.status === "available" ? <><p className="metric-value mt-3 text-5xl font-black">{formatDelay(comparison.value.meanDelaySeconds, lang)}</p><p className="mt-2 text-sm text-muted">{messages.live.comparisonDescription} · {comparison.value.sample} {messages.history.sample}</p></> : <p className="mt-3 border-y border-border py-6 text-sm text-muted">{comparison.status === "insufficient-sample" ? messages.live.comparisonInsufficient : messages.live.comparisonUnavailable}</p>}</div>
      </section>
    </div>
  );
}
