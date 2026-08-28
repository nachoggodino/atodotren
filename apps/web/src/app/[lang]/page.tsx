import type { Metadata } from "next";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LandingDelayTrend } from "@/components/charts/landing-delay-trend";
import { LandingActions } from "@/components/landing/landing-actions";
import { LandingMetrics } from "@/components/landing/landing-metrics";
import { EntitySearch } from "@/components/search/entity-search";
import { BRAND } from "@/lib/brand/config";
import { formatDuration } from "@/lib/domain/format";
import { getMessages, isLang } from "@/lib/i18n";
import { localizedPageMetadata, sharedLocalizedPath } from "@/lib/seo";
import { getLandingOverview } from "@/lib/server/services";
import { metadataCopy } from "@/messages/metadata";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { readonly params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  const copy = metadataCopy[lang];
  return localizedPageMetadata({ lang, paths: sharedLocalizedPath(""), title: copy.landingTitle, description: copy.landingDescription });
}

export default async function LandingPage({ params, searchParams }: { readonly params: Promise<{ lang: string }>; readonly searchParams: Promise<{ scenario?: string }> }) {
  const [{ lang }, query] = await Promise.all([params, searchParams]);
  if (!isLang(lang)) notFound();
  const messages = getMessages(lang);
  const data = await getLandingOverview(query.scenario);
  const titleHighlightIndex = messages.landing.title.indexOf(messages.landing.titleHighlight);
  const hasTitleHighlight = titleHighlightIndex >= 0;

  return <div className="page-shell overflow-x-clip pb-6 pt-9 sm:pb-8 sm:pt-14">
    <section className="mx-auto max-w-4xl text-center">
      <blockquote>
        <h1 className="mx-auto w-[84.375%] max-w-4xl text-[27px] font-bold leading-[1.04] tracking-[-.035em] sm:w-[86.111%] sm:text-[31px] lg:w-[89.583%] lg:text-[43px]">“{hasTitleHighlight ? <>{messages.landing.title.slice(0, titleHighlightIndex)}<strong className="font-black text-[var(--landing-highlight)]" data-testid="landing-title-highlight">{messages.landing.titleHighlight}</strong>{messages.landing.title.slice(titleHighlightIndex + messages.landing.titleHighlight.length)}</> : messages.landing.title}”</h1>
      </blockquote>
      <p className="mx-auto mt-4 max-w-2xl text-[.825rem] leading-6 text-muted sm:text-sm">{messages.landing.body}</p>
    </section>

    <LandingMetrics activeDelaySeconds={data.activeDelaySeconds} activeTrains={data.activeTrains} dayDelaySeconds={data.dayDelaySeconds} lang={lang} messages={messages} />

    <section className="mt-7 grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
      <EntitySearch lang={lang} messages={messages} />
      <LandingActions lang={lang} messages={messages} />
    </section>

    <section className="mt-10" data-testid="landing-delay-trend">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2"><div><p className="eyebrow">{messages.landing.delayTrend}</p><h2 className="mt-1 text-2xl font-black tracking-tight text-[var(--landing-delay)]">{formatDuration(data.dayDelaySeconds, lang)}</h2></div><span className="text-xs font-bold text-muted">{messages.landing.delayTrendWindow}</span></div>
      <LandingDelayTrend points={data.trend} lang={lang} messages={messages} />
    </section>

    <footer className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5 text-sm text-muted"><span>{BRAND.name} · {messages.landing.footerDescription}</span><Link className="flex items-center gap-1 rounded-md px-1 py-1 font-bold text-foreground transition-[transform,opacity] duration-100 active:scale-[.96] active:opacity-70" href={`/${lang}/methodology`}>{messages.landing.methodology}<ArrowUpRight className="size-4" /></Link></footer>
  </div>;
}
