import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { LineBadge } from "@/components/line-badge";
import { LivePageSummary } from "@/components/live/live-page-summary";
import { formatDelay } from "@/lib/domain/format";
import { humanizeSlug } from "@/lib/domain/slugs";
import { positionCaptionKey } from "@/lib/domain/train";
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

  return (
    <div className="page-shell pb-20 pt-7 sm:pt-9">
      <LivePageSummary backLabel={messages.common.back} meta={data.meta} stats={data.stats} lang={lang} messages={messages} title={messages.nav.live} subtitle={data.context.name[lang]} />
      <section className="mt-12">
        <h2 className="text-2xl font-black">{messages.live.trains}</h2>
        {data.trains.length === 0 ? <p className="mt-4 border-y border-border py-8 text-muted">{messages.live.overnight}</p> : (
          <div className="mt-4 divide-y divide-border border-y border-border">
            {data.trains.map((train) => {
              const caption = positionCaptionKey(train.position);
              return <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 py-4" key={train.id}><LineBadge code={train.line.code} color={train.line.color} /><div><strong>{train.id}</strong><p className="text-xs text-muted">{caption === "reported" ? messages.live.reported : caption === "inferred" ? messages.live.inferred : messages.live.positionUnavailable}</p></div><strong className="metric-value">{formatDelay(train.delaySeconds, lang)}</strong></div>;
            })}
          </div>
        )}
      </section>
    </div>
  );
}
