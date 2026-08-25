import { notFound, redirect } from "next/navigation";
import { HistoryFiltersForm } from "@/components/history/history-filters";
import { HistoryLayout } from "@/components/history/history-layout";
import { InvalidHistoryFilters } from "@/components/history/invalid-filters";
import { historyFiltersToSearchParams, tryHistoryFiltersFromPage, type PageSearchParams } from "@/lib/domain/page-params";
import { getMessages, isLang } from "@/lib/i18n";
import { getHistoryStation } from "@/lib/server/services";

export const dynamic = "force-dynamic";

export default async function HistoryStationPage({ params, searchParams }: { readonly params: Promise<{ lang: string; slug: string }>; readonly searchParams: Promise<PageSearchParams> }) {
  const [{ lang, slug }, query] = await Promise.all([params, searchParams]);
  if (!isLang(lang)) notFound();
  const messages = getMessages(lang);
  const parsed = tryHistoryFiltersFromPage(query);
  if (!parsed.ok) return <InvalidHistoryFilters messages={messages} />;
  const scenario = typeof query.scenario === "string" ? query.scenario : undefined;
  const data = await getHistoryStation(slug, parsed.filters, scenario);
  if (data === null) notFound();

  const canonicalSlug = data.context.slug?.[lang];
  if (canonicalSlug !== undefined && slug !== canonicalSlug) {
    redirect(`/${lang}/history/station/${canonicalSlug}?${historyFiltersToSearchParams(parsed.filters, scenario)}`);
  }

  return <HistoryLayout data={data} lang={lang} messages={messages} filterForm={<HistoryFiltersForm filters={parsed.filters} directions={data.directions} lang={lang} messages={messages} />} />;
}
