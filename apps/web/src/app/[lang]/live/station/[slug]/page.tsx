import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { DelayDistribution } from "@/components/charts/delay-distribution";
import { StationDelayTrend } from "@/components/charts/station-delay-trend";
import { LivePageSummary } from "@/components/live/live-page-summary";
import { StationTrainList } from "@/components/live/station-train-list";
import { formatDuration } from "@/lib/domain/format";
import { humanizeSlug } from "@/lib/domain/slugs";
import { getMessages, isLang } from "@/lib/i18n";
import { localizedPageMetadata, sharedLocalizedPath } from "@/lib/seo";
import { getLiveStation } from "@/lib/server/services";
import { contextDescription, metadataCopy } from "@/messages/metadata";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { readonly params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLang(lang)) return {};
  const copy = metadataCopy[lang];
  const context = humanizeSlug(slug);
  return localizedPageMetadata({ lang, paths: sharedLocalizedPath(`/live/station/${slug}`), title: `${context} · ${copy.liveNetworkTitle}`, description: contextDescription(copy.liveStationDescription, context) });
}

export default async function LiveStationPage({ params, searchParams }: { readonly params: Promise<{ lang: string; slug: string }>; readonly searchParams: Promise<{ scenario?: string }> }) {
  const [{ lang, slug }, query] = await Promise.all([params, searchParams]);
  if (!isLang(lang)) notFound();
  const messages = getMessages(lang);
  const data = await getLiveStation(slug, query.scenario);
  if (data === null || "code" in data.context) notFound();

  const canonicalSlug = data.context.slug[lang];
  if (slug !== canonicalSlug) {
    const suffix = query.scenario === undefined ? "" : `?${new URLSearchParams({ scenario: query.scenario })}`;
    redirect(`/${lang}/live/station/${canonicalSlug}${suffix}`);
  }

  const nextTrain = data.trains[0];
  return (
    <div className="page-shell pb-20 pt-7 sm:pt-9">
      <LivePageSummary {...(nextTrain === undefined ? {} : { contextColor: nextTrain.line.color })} backLabel={messages.common.back} context="station" meta={data.meta} stats={data.stats} lang={lang} messages={messages} title={messages.nav.live} subtitle={data.context.name[lang]} />
      <section className="mt-10" data-testid="station-total-delay">
        <p className="eyebrow">{messages.live.stationAccumulatedDelay} {data.context.name[lang]}</p>
        <p className="metric-value mt-3 text-5xl font-black">{formatDuration(data.stationInsights.totalAddedDelaySeconds, lang)}</p>
      </section>
      <section className="mt-10">
        <h2 className="text-2xl font-black">{messages.live.upcomingTrains}</h2>
        {data.trains.length === 0 ? <p className="mt-4 border-y border-border py-8 text-muted">{messages.live.noUpcomingTrains}</p> : <StationTrainList generatedAt={data.meta.generatedAt} lang={lang} messages={messages} trains={data.trains} />}
      </section>
      <section className="mt-12 grid gap-10 border-t border-border pt-8 lg:grid-cols-[1.15fr_.85fr]">
        <div><h2 className="text-2xl font-black">{messages.live.stationDelayTrend}</h2><div className="mt-4"><StationDelayTrend messages={messages} points={data.stationInsights.delayTrend} /></div></div>
        <div><h2 className="text-2xl font-black">{messages.live.todayDistributionTitle}</h2><div className="mt-4"><DelayDistribution messages={messages} values={data.stats.distribution} /></div><p className="mt-2 text-xs text-muted">{messages.live.todayDistributionBody}</p></div>
      </section>
    </div>
  );
}
