import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { HistoryFiltersForm } from "@/components/history/history-filters";
import { HistoryLayout } from "@/components/history/history-layout";
import { InvalidHistoryFilters } from "@/components/history/invalid-filters";
import { historyFiltersToSearchParams, tryHistoryFiltersFromPage, type PageSearchParams } from "@/lib/domain/page-params";
import { humanizeSlug } from "@/lib/domain/slugs";
import { getMessages, isLang } from "@/lib/i18n";
import { localizedPageMetadata, sharedLocalizedPath } from "@/lib/seo";
import { getHistoryStation } from "@/lib/server/services";
import { contextDescription, metadataCopy } from "@/messages/metadata";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { readonly params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLang(lang)) return {};
  const copy = metadataCopy[lang];
  const context = humanizeSlug(slug);
  return localizedPageMetadata({ lang, paths: sharedLocalizedPath(`/explore/station/${slug}`), title: `${context} · ${copy.historyNetworkTitle}`, description: contextDescription(copy.historyStationDescription, context) });
}

export default async function ExploreStationPage({ params, searchParams }: { readonly params: Promise<{ lang: string; slug: string }>; readonly searchParams: Promise<PageSearchParams> }) {
  const [{ lang, slug }, query] = await Promise.all([params, searchParams]);
  if (!isLang(lang)) notFound();
  const messages = getMessages(lang);
  const parsed = tryHistoryFiltersFromPage(query);
  if (!parsed.ok) return <InvalidHistoryFilters messages={messages} />;
  const scenario = typeof query.scenario === "string" ? query.scenario : undefined;
  const data = await getHistoryStation(slug, parsed.filters, scenario);
  if (data === null) notFound();

  const canonicalSlug = data.context.slug?.[lang];
  if (canonicalSlug !== undefined && slug !== canonicalSlug) redirect(`/${lang}/explore/station/${canonicalSlug}?${historyFiltersToSearchParams(parsed.filters, scenario)}`);

  return <HistoryLayout data={data} lang={lang} messages={messages} filterForm={<HistoryFiltersForm filters={parsed.filters} lang={lang} messages={messages} />} />;
}
