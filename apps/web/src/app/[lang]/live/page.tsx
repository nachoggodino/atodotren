import { notFound } from "next/navigation";
import { DelayDistribution } from "@/components/charts/delay-distribution";
import { DataMeta } from "@/components/feedback/data-meta";
import { LineList } from "@/components/live/line-list";
import { LiveHeader } from "@/components/live/live-header";
import { LiveRefresh } from "@/components/live/live-refresh";
import { StatsBand } from "@/components/live/stats-band";
import { getMessages, isLang } from "@/lib/i18n";
import { getLiveNetwork } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export default async function LivePage({ params, searchParams }: { readonly params: Promise<{ lang: string }>; readonly searchParams: Promise<{ scenario?: string }> }) {
  const [{ lang }, query] = await Promise.all([params, searchParams]);
  if (!isLang(lang)) notFound();
  const messages = getMessages(lang);
  const data = await getLiveNetwork(query.scenario);

  return (
    <div className="page-shell pb-20 pt-7 sm:pt-9">
      <LiveHeader title={messages.nav.live} subtitle={messages.live.networkTitle} />
      <div className="mt-5">
        <DataMeta meta={data.meta} lang={lang} messages={messages} variant="live" />
        <LiveRefresh messages={messages} />
      </div>
      <div className="mt-6"><StatsBand stats={data.stats} lang={lang} messages={messages} variant="live" /></div>
      <section className="mt-10" aria-label={messages.live.networkTitle}>
        <LineList lines={data.lines} lang={lang} messages={messages} />
      </section>
      <section className="mt-8">
        <h2 className="text-2xl font-black tracking-tight">{messages.charts.delayDistribution}</h2>
        <div className="mt-4"><DelayDistribution values={data.stats.distribution} messages={messages} /></div>
      </section>
    </div>
  );
}
