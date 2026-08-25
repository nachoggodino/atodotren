import type { Metadata } from "next";
import { ArrowRight, ArrowUpRight, BarChart3, Radio } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LandingDelayTrend } from "@/components/charts/landing-delay-trend";
import { EntitySearch } from "@/components/search/entity-search";
import { BRAND } from "@/lib/brand/config";
import { formatDuration } from "@/lib/domain/format";
import { getMessages, isLang } from "@/lib/i18n";
import { publicBaseUrl } from "@/lib/seo";
import { getLandingOverview } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { readonly params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang) || publicBaseUrl() === null) return {};
  return { alternates: { canonical: `/${lang}`, languages: { es: "/es", en: "/en", "x-default": "/es" } } };
}

export default async function LandingPage({ params, searchParams }: { readonly params: Promise<{ lang: string }>; readonly searchParams: Promise<{ scenario?: string }> }) {
  const [{ lang }, query] = await Promise.all([params, searchParams]);
  if (!isLang(lang)) notFound();
  const messages = getMessages(lang);
  const data = await getLandingOverview(query.scenario);
  const number = new Intl.NumberFormat(lang === "es" ? "es-ES" : "en-GB");

  return <div className="page-shell pb-16 pt-9 sm:pt-14">
    <section className="mx-auto max-w-4xl text-center">
      <p className="eyebrow">{messages.landing.eyebrow}</p>
      <blockquote className="mt-3">
        <h1 className="mx-auto max-w-4xl text-[2rem] font-bold leading-[1.04] tracking-[-.035em] sm:text-4xl lg:text-5xl">“{messages.landing.title}”</h1>
      </blockquote>
      <p className="mx-auto mt-4 max-w-2xl text-[.95rem] leading-7 text-muted sm:text-base">{messages.landing.body}</p>
    </section>

    <section className="mt-9 overflow-hidden rounded-2xl border border-border bg-surface-strong" data-testid="landing-live-metrics">
      <div className="grid grid-cols-3 divide-x divide-border">
        <div className="min-w-0 px-3 py-4 sm:px-5"><p className="text-[.56rem] font-bold uppercase tracking-[.08em] text-muted sm:text-[.625rem]">{messages.landing.activeTrains}</p><p className="metric-value mt-1 text-xl font-black sm:text-2xl">{number.format(data.activeTrains)}</p></div>
        <div className="min-w-0 px-3 py-4 sm:px-5"><p className="text-[.56rem] font-bold uppercase tracking-[.08em] text-muted sm:text-[.625rem]">{messages.landing.activeDelay}</p><p className="metric-value mt-1 text-[.94rem] font-black sm:text-[1.18rem]">{formatDuration(data.activeDelaySeconds, lang)}</p></div>
        <div className="min-w-0 px-3 py-4 sm:px-5"><p className="text-[.56rem] font-bold uppercase tracking-[.08em] text-muted sm:text-[.625rem]">{messages.landing.todayDelay}</p><p className="metric-value mt-1 text-[.94rem] font-black sm:text-[1.18rem]">{formatDuration(data.dayDelaySeconds, lang)}</p></div>
      </div>
    </section>

    <section className="mt-7 grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
      <EntitySearch lang={lang} messages={messages} />
      <div className="grid grid-cols-2 gap-3">
        <Link className="group flex min-h-16 items-center gap-3 rounded-2xl border border-border bg-surface-strong px-4 font-black transition hover:-translate-y-0.5 hover:shadow-sm" href={`/${lang}/live`}><Radio className="size-5 shrink-0 text-success" /><span className="flex-1">{messages.landing.summaryLive}</span><ArrowRight className="size-4 text-muted transition group-hover:translate-x-0.5" /></Link>
        <Link className="group flex min-h-16 items-center gap-3 rounded-2xl border border-border bg-surface-strong px-4 font-black transition hover:-translate-y-0.5 hover:shadow-sm" href={`/${lang}/history`}><BarChart3 className="size-5 shrink-0 text-primary" /><span className="flex-1">{messages.landing.summaryHistory}</span><ArrowRight className="size-4 text-muted transition group-hover:translate-x-0.5" /></Link>
      </div>
    </section>

    <section className="mt-10" data-testid="landing-delay-trend">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div><p className="eyebrow">{messages.landing.delayTrend}</p><h2 className="mt-1 text-2xl font-black tracking-tight">{formatDuration(data.dayDelaySeconds, lang)}</h2></div>
        <span className="text-xs font-bold text-muted">{messages.landing.delayTrendWindow}</span>
      </div>
      <LandingDelayTrend points={data.trend} lang={lang} messages={messages} />
    </section>

    <footer className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6 text-sm text-muted"><span>{BRAND.name} · {messages.landing.footerDescription}</span><Link className="flex items-center gap-1 font-bold text-foreground" href={`/${lang}/methodology`}>{messages.landing.methodology}<ArrowUpRight className="size-4" /></Link></footer>
  </div>;
}
