import type { Metadata } from "next";
import { ArrowRight, ArrowUpRight, BarChart3, Radio } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LandingDelayTrend } from "@/components/charts/landing-delay-trend";
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
  const number = new Intl.NumberFormat(lang === "es" ? "es-ES" : "en-GB");
  const titleHighlightIndex = messages.landing.title.indexOf(messages.landing.titleHighlight);
  const hasTitleHighlight = titleHighlightIndex >= 0;

  return <div className="page-shell overflow-x-clip pb-6 pt-9 sm:pb-8 sm:pt-14">
    <section className="mx-auto max-w-4xl text-center">
      <blockquote>
        <h1 className="mx-auto max-w-4xl text-[2rem] font-bold leading-[1.04] tracking-[-.035em] sm:text-4xl lg:text-5xl">“{hasTitleHighlight ? <>{messages.landing.title.slice(0, titleHighlightIndex)}<strong className="font-black text-[var(--landing-highlight)]" data-testid="landing-title-highlight">{messages.landing.titleHighlight}</strong>{messages.landing.title.slice(titleHighlightIndex + messages.landing.titleHighlight.length)}</> : messages.landing.title}”</h1>
      </blockquote>
      <p className="mx-auto mt-4 max-w-2xl text-[.825rem] leading-6 text-muted sm:text-sm">{messages.landing.body}</p>
    </section>

    <section className="mt-9 overflow-hidden rounded-2xl border border-border bg-surface-strong" data-testid="landing-live-metrics">
      <div className="grid grid-cols-3 divide-x divide-border">
        <div className="flex min-h-[5.75rem] min-w-0 flex-col items-center justify-center gap-1 px-3 py-3 text-center sm:min-h-24 sm:px-5" data-testid="landing-metric-active-delay" style={{ background: "color-mix(in srgb, var(--landing-delay) 4%, var(--surface-strong))" }}><p className="flex h-6 items-end justify-center text-[.5rem] font-bold uppercase leading-tight tracking-[.07em] text-muted sm:text-[.55rem]">{messages.landing.activeDelay}</p><p className="metric-value flex h-8 items-center justify-center text-[.94rem] font-black text-[var(--landing-delay)] sm:text-[1.18rem]">{formatDuration(data.activeDelaySeconds, lang)}</p></div>
        <div className="flex min-h-[5.75rem] min-w-0 flex-col items-center justify-center gap-1 px-3 py-3 text-center sm:min-h-24 sm:px-5" data-testid="landing-metric-active-trains" style={{ background: "color-mix(in srgb, var(--landing-positive) 6%, var(--surface-strong))" }}><p className="flex h-6 items-end justify-center text-[.5rem] font-bold uppercase leading-tight tracking-[.07em] text-muted sm:text-[.55rem]">{messages.landing.activeTrains}</p><p className="metric-value flex h-8 items-center justify-center text-[29px] font-black leading-none text-[var(--landing-positive)] sm:text-[33px]" data-testid="landing-active-trains-value">{number.format(data.activeTrains)}</p></div>
        <div className="flex min-h-[5.75rem] min-w-0 flex-col items-center justify-center gap-1 px-3 py-3 text-center sm:min-h-24 sm:px-5" data-testid="landing-metric-today-delay" style={{ background: "color-mix(in srgb, var(--landing-delay) 6%, var(--surface-strong))" }}><p className="flex h-6 items-end justify-center text-[.5rem] font-bold uppercase leading-tight tracking-[.07em] text-muted sm:text-[.55rem]">{messages.landing.todayDelay}</p><p className="metric-value flex h-8 items-center justify-center text-[.94rem] font-black text-[var(--landing-delay)] sm:text-[1.18rem]">{formatDuration(data.dayDelaySeconds, lang)}</p></div>
      </div>
    </section>

    <section className="mt-7 grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
      <EntitySearch lang={lang} messages={messages} />
      <div className="grid grid-cols-2 gap-3">
        <Link data-testid="landing-live-link" className="group flex min-h-16 items-center gap-3 rounded-2xl border border-border px-4 font-black transition-[transform,box-shadow,opacity] duration-100 hover:-translate-y-0.5 hover:shadow-sm active:scale-[.97] active:opacity-80 active:shadow-none" style={{ background: "color-mix(in srgb, var(--landing-positive) 4%, var(--surface-strong))" }} href={`/${lang}/live`}><Radio className="size-5 shrink-0 text-[var(--landing-positive)]" /><span className="flex-1">{messages.landing.summaryLive}</span><ArrowRight className="size-4 text-muted transition group-hover:translate-x-0.5" /></Link>
        <Link data-testid="landing-history-link" className="group flex min-h-16 items-center gap-3 rounded-2xl border border-border px-4 font-black transition-[transform,box-shadow,opacity] duration-100 hover:-translate-y-0.5 hover:shadow-sm active:scale-[.97] active:opacity-80 active:shadow-none" style={{ background: "color-mix(in srgb, var(--landing-highlight) 4%, var(--surface-strong))" }} href={`/${lang}/history`}><BarChart3 className="size-5 shrink-0 text-[var(--landing-highlight)]" /><span className="flex-1">{messages.landing.summaryHistory}</span><ArrowRight className="size-4 text-muted transition group-hover:translate-x-0.5" /></Link>
      </div>
    </section>

    <section className="mt-10" data-testid="landing-delay-trend">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2"><div><p className="eyebrow">{messages.landing.delayTrend}</p><h2 className="mt-1 text-2xl font-black tracking-tight text-[var(--landing-delay)]">{formatDuration(data.dayDelaySeconds, lang)}</h2></div><span className="text-xs font-bold text-muted">{messages.landing.delayTrendWindow}</span></div>
      <LandingDelayTrend points={data.trend} lang={lang} messages={messages} />
    </section>

    <footer className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5 text-sm text-muted"><span>{BRAND.name} · {messages.landing.footerDescription}</span><Link className="flex items-center gap-1 rounded-md px-1 py-1 font-bold text-foreground transition-[transform,opacity] duration-100 active:scale-[.96] active:opacity-70" href={`/${lang}/methodology`}>{messages.landing.methodology}<ArrowUpRight className="size-4" /></Link></footer>
  </div>;
}
