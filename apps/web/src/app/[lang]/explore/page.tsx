import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HistoryFiltersForm } from "@/components/history/history-filters";
import { HistoryLayout } from "@/components/history/history-layout";
import { InvalidHistoryFilters } from "@/components/history/invalid-filters";
import { MADRID_NETWORK } from "@/lib/domain/network";
import { historyFiltersToSearchParams, tryHistoryFiltersFromPage, type PageSearchParams } from "@/lib/domain/page-params";
import { getMessages, isLang } from "@/lib/i18n";
import { localizedPageMetadata, sharedLocalizedPath } from "@/lib/seo";
import { getHistoryNetwork, getHistoryTrend } from "@/lib/server/services";
import { metadataCopy } from "@/messages/metadata";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { readonly params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLang(lang)) return {};
  const copy = metadataCopy[lang];
  return localizedPageMetadata({ lang, paths: sharedLocalizedPath("/explore"), title: copy.historyNetworkTitle, description: copy.historyNetworkDescription });
}

export default async function ExplorePage({ params, searchParams }: { readonly params: Promise<{ lang: string }>; readonly searchParams: Promise<PageSearchParams> }) {
  const [{ lang }, query] = await Promise.all([params, searchParams]);
  if (!isLang(lang)) notFound();
  const messages = getMessages(lang);
  const parsed = tryHistoryFiltersFromPage(query);
  if (!parsed.ok) return <InvalidHistoryFilters messages={messages} />;
  const scenario = typeof query.scenario === "string" ? query.scenario : undefined;
  const [data, trend] = await Promise.all([
    getHistoryNetwork(parsed.filters, scenario),
    getHistoryTrend({ kind: "network", key: MADRID_NETWORK.slug }, parsed.filters, scenario),
  ]);
  const filterKey = historyFiltersToSearchParams(parsed.filters, scenario).toString();
  return <HistoryLayout
    data={data}
    trend={trend}
    lang={lang}
    messages={messages}
    filterForm={<HistoryFiltersForm key={filterKey} filters={parsed.filters} messages={messages} />}
    {...(scenario === undefined ? {} : { scenario })}
  />;
}
