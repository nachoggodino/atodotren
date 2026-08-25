import type { Metadata } from "next";
import { ArrowUpRight, BarChart3, Radio } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EntitySearch } from "@/components/search/entity-search";
import { BrandSymbol } from "@/components/shell/brand-mark";
import { BRAND } from "@/lib/brand/config";
import { getMessages, isLang } from "@/lib/i18n";
import { publicBaseUrl } from "@/lib/seo";

export async function generateMetadata({ params }: { readonly params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang) || publicBaseUrl() === null) return {};
  return {
    alternates: {
      canonical: `/${lang}`,
      languages: { es: "/es", en: "/en", "x-default": "/es" },
    },
  };
}

export default async function LandingPage({ params }: { readonly params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  const messages = getMessages(lang);
  return <div className="page-shell pb-20 pt-14 sm:pt-20">
    <section className="grid items-end gap-10 lg:grid-cols-[1.2fr_.8fr] lg:gap-16">
      <div>
        <p className="eyebrow">{messages.landing.eyebrow}</p>
        <h1 className="mt-4 max-w-4xl text-5xl font-black leading-[.94] tracking-[-.065em] sm:text-7xl">{messages.landing.title}</h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-muted sm:text-xl">{messages.landing.body}</p>
      </div>
      <div aria-hidden="true" className="relative mx-auto aspect-[4/3] w-full max-w-sm text-primary">
        <svg className="h-full w-full" viewBox="0 0 420 315"><path d="M38 258C103 248 121 194 169 186s71 23 108-3 40-78 109-89" fill="none" stroke="currentColor" strokeWidth="11" strokeLinecap="round" opacity=".2" /><circle cx="81" cy="235" r="9" fill="var(--accent)" /><circle cx="181" cy="186" r="9" fill="var(--accent)" /><circle cx="307" cy="156" r="9" fill="var(--accent)" /><g transform="translate(190 68) scale(2.7)"><BrandSymbol className="size-10" /></g></svg>
      </div>
    </section>
    <section className="mt-14 grid gap-8 border-t border-border pt-8 lg:grid-cols-[1.2fr_.8fr] lg:gap-16">
      <EntitySearch lang={lang} messages={messages} />
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border">
        <Link className="bg-surface-strong p-5 hover:bg-muted-soft" href={`/${lang}/live`}><Radio className="size-5 text-success" /><span className="mt-8 block text-2xl font-black tracking-tight">{messages.landing.summaryLive}</span><span className="mt-1 block text-sm text-muted">{messages.landing.liveSummaryDetail}</span></Link>
        <Link className="bg-surface-strong p-5 hover:bg-muted-soft" href={`/${lang}/history`}><BarChart3 className="size-5 text-primary" /><span className="mt-8 block text-2xl font-black tracking-tight">{messages.landing.summaryHistory}</span><span className="mt-1 block text-sm text-muted">{messages.landing.historySummaryDetail}</span></Link>
      </div>
    </section>
    <footer className="mt-16 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6 text-sm text-muted"><span>{BRAND.name} · {messages.landing.footerDescription}</span><Link className="flex items-center gap-1 font-bold text-foreground" href={`/${lang}/methodology`}>{messages.landing.methodology}<ArrowUpRight className="size-4" /></Link></footer>
  </div>;
}
