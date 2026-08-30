import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HistoryFiltersForm } from "@/components/history/history-filters";
import { HistoryLayout } from "@/components/history/history-layout";
import { InvalidHistoryFilters } from "@/components/history/invalid-filters";
import { TimetableMatrix } from "@/components/history/timetable-matrix";
import type { MatrixResult } from "@/lib/domain/contracts";
import { matrixResultMessage } from "@/lib/domain/matrix-result";
import { historyFiltersToSearchParams, tryHistoryFiltersFromPage, type PageSearchParams } from "@/lib/domain/page-params";
import { getMessages, isLang } from "@/lib/i18n";
import { localizedPageMetadata, sharedLocalizedPath } from "@/lib/seo";
import { getHistoryLine, getMatrix } from "@/lib/server/services";
import { contextDescription, metadataCopy } from "@/messages/metadata";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { readonly params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLang(lang)) return {};
  const copy = metadataCopy[lang];
  const context = slug.toUpperCase();
  return localizedPageMetadata({ lang, paths: sharedLocalizedPath(`/explore/line/${slug}`), title: `${context} · ${copy.historyNetworkTitle}`, description: contextDescription(copy.historyLineDescription, context) });
}

function matrixView(result: MatrixResult, lang: "es" | "en", messages: ReturnType<typeof getMessages>) {
  if (result.status === "available") return <TimetableMatrix matrix={result.matrix} lang={lang} messages={messages} />;
  return <p className={`border-y border-border py-8 text-sm ${result.status === "failed" ? "text-danger" : "text-muted"}`}>{matrixResultMessage(result, messages)}</p>;
}

export default async function ExploreLinePage({ params, searchParams }: { readonly params: Promise<{ lang: string; slug: string }>; readonly searchParams: Promise<PageSearchParams> }) {
  const [{ lang, slug }, query] = await Promise.all([params, searchParams]);
  if (!isLang(lang)) notFound();
  const messages = getMessages(lang);
  const parsed = tryHistoryFiltersFromPage(query);
  if (!parsed.ok) return <InvalidHistoryFilters messages={messages} />;
  const scenario = typeof query.scenario === "string" ? query.scenario : undefined;
  const [data, matrix] = await Promise.all([getHistoryLine(slug, parsed.filters, scenario), getMatrix(slug, parsed.filters.to, scenario)]);
  if (data === null) notFound();
  const filterKey = historyFiltersToSearchParams(parsed.filters, scenario).toString();
  return <HistoryLayout data={data} lang={lang} messages={messages} filterForm={<HistoryFiltersForm key={filterKey} filters={parsed.filters} messages={messages} />} matrix={matrixView(matrix, lang, messages)} />;
}
