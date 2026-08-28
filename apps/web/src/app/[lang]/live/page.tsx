import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DelayDistribution } from "@/components/charts/delay-distribution";
import { LineList } from "@/components/live/line-list";
import { LivePageSummary } from "@/components/live/live-page-summary";
import { getMessages, isLang } from "@/lib/i18n";
import { localizedPageMetadata, sharedLocalizedPath } from "@/lib/seo";
import { getLiveNetwork } from "@/lib/server/services";
import { metadataCopy } from "@/messages/metadata";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { readonly params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  const copy = metadataCopy[lang];
  return localizedPageMetadata({ lang, paths: sharedLocalizedPath("/live"), title: copy.liveNetworkTitle, description: copy.liveNetworkDescription });
}

export default async function LivePage({ params, searchParams }: { readonly params: Promise<{ lang: string }>; readonly searchParams: Promise<{ scenario?: string }> }) {
  const [{ lang }, query] = await Promise.all([params, searchParams]);
  if (!isLang(lang)) notFound();
  const messages = getMessages(lang);
  const data = await getLiveNetwork(query.scenario);

  return (
    <div className="page-shell pb-20 pt-7 sm:pt-9">
      <LivePageSummary meta={data.meta} stats={data.stats} lang={lang} messages={messages} title={messages.nav.live} subtitle={messages.live.networkTitle} />
      <section className="mt-10" aria-label={messages.live.networkTitle}><LineList lines={data.lines} lang={lang} messages={messages} /></section>
      <section className="mt-8"><h2 className="text-2xl font-black tracking-tight">{messages.live.todayDistributionTitle}</h2><div className="mt-4"><DelayDistribution values={data.stats.distribution} messages={messages} /></div></section>
    </div>
  );
}
