import { notFound, redirect } from "next/navigation";
import { DataMeta } from "@/components/feedback/data-meta";
import { LineBadge } from "@/components/line-badge";
import { LiveHeader } from "@/components/live/live-header";
import { LiveRefresh } from "@/components/live/live-refresh";
import { StatsBand } from "@/components/live/stats-band";
import { formatDelay } from "@/lib/domain/format";
import { positionCaptionKey } from "@/lib/domain/train";
import { getMessages, isLang } from "@/lib/i18n";
import { getLiveStation } from "@/lib/server/services";

export const dynamic = "force-dynamic";

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

  return (
    <div className="page-shell pb-20 pt-7 sm:pt-9">
      <LiveHeader title={messages.nav.live} subtitle={data.context.name[lang]} />
      <div className="mt-5">
        <DataMeta meta={data.meta} lang={lang} messages={messages} variant="live" />
        <LiveRefresh messages={messages} />
      </div>
      <div className="mt-6"><StatsBand stats={data.stats} lang={lang} messages={messages} variant="live" /></div>
      <section className="mt-12">
        <h2 className="text-2xl font-black">{messages.live.trains}</h2>
        {data.trains.length === 0 ? <p className="mt-4 border-y border-border py-8 text-muted">{messages.live.overnight}</p> : (
          <div className="mt-4 divide-y divide-border border-y border-border">
            {data.trains.map((train) => {
              const caption = positionCaptionKey(train.position);
              return (
                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 py-4" key={train.id}>
                  <LineBadge code={train.line.code} color={train.line.color} />
                  <div>
                    <strong>{train.id}</strong>
                    <p className="text-xs text-muted">{caption === "reported" ? messages.live.reported : caption === "inferred" ? messages.live.inferred : messages.live.positionUnavailable}</p>
                  </div>
                  <strong className="metric-value">{formatDelay(train.delaySeconds, lang)}</strong>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
