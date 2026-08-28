import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { LineBadge } from "@/components/line-badge";
import { LivePageSummary } from "@/components/live/live-page-summary";
import { formatCompactDelay } from "@/lib/domain/format";
import { humanizeSlug } from "@/lib/domain/slugs";
import { getMessages, isLang } from "@/lib/i18n";
import { localizedPageMetadata, sharedLocalizedPath } from "@/lib/seo";
import { getLiveStation } from "@/lib/server/services";
import { contextDescription, metadataCopy } from "@/messages/metadata";

export const dynamic = "force-dynamic";

function remainingMinutes(arrivalAt: string | null, generatedAt: string, lang: "es" | "en"): string {
  if (arrivalAt === null) return "—";
  const remainingMs = Date.parse(arrivalAt) - Date.parse(generatedAt);
  if (!Number.isFinite(remainingMs)) return "—";
  const minutes = Math.max(0, Math.ceil(remainingMs / 60_000));
  return `${new Intl.NumberFormat(lang === "es" ? "es-ES" : "en-GB", { useGrouping: false }).format(minutes)} m`;
}

function stationDelay(delaySeconds: number | null, lang: "es" | "en"): string {
  return formatCompactDelay(delaySeconds, lang).replace(/^\+/, "");
}

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
      <LivePageSummary backLabel={messages.common.back} context="station" contextColor={data.trains[0]?.line.color} meta={data.meta} stats={data.stats} lang={lang} messages={messages} title={messages.nav.live} subtitle={data.context.name[lang]} />
      <section className="mt-12">
        <h2 className="text-2xl font-black">{messages.live.upcomingTrains}</h2>
        {data.trains.length === 0 ? <p className="mt-4 border-y border-border py-8 text-muted">{messages.live.noUpcomingTrains}</p> : (
          <div className="mt-4 divide-y divide-border border-y border-border">
            {data.trains.map((train) => {
              const station = train.currentStation ?? train.previousStation;
              const arrivalAt = train.probableArrivalAt ?? train.scheduledArrivalAt;
              const eta = remainingMinutes(arrivalAt, data.meta.generatedAt, lang);
              return (
                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-4" key={`${train.journeyId}-${train.id}`}>
                  <LineBadge code={train.line.code} color={train.line.color} variant="compact" />
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <strong className="shrink-0">{train.id}</strong>
                      <span aria-hidden="true" className="text-muted">·</span>
                      <span className="truncate text-sm text-muted">{station?.name[lang] ?? messages.live.positionUnavailable}</span>
                    </div>
                    <p className="mt-1 text-[.68rem] font-bold uppercase tracking-wide text-muted">{messages.live.delay}: {stationDelay(train.delaySeconds, lang)}</p>
                  </div>
                  <strong className="metric-value whitespace-nowrap text-xl font-black tabular-nums sm:text-2xl"><span className="sr-only">{messages.live.arrivalIn} </span>{eta}</strong>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
