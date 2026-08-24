import { notFound } from "next/navigation";
import { HistoryFiltersForm } from "@/components/history/history-filters";
import { HistoryLayout } from "@/components/history/history-layout";
import { historyFiltersFromPage, type PageSearchParams } from "@/lib/domain/page-params";
import { getMessages, isLang } from "@/lib/i18n";
import { getHistoryStation } from "@/lib/server/services";

export const dynamic = "force-dynamic";
export default async function HistoryStationPage({ params, searchParams }: { readonly params: Promise<{ lang: string; slug: string }>; readonly searchParams: Promise<PageSearchParams> }) { const [{ lang, slug }, query] = await Promise.all([params, searchParams]); if (!isLang(lang)) notFound(); const filters = historyFiltersFromPage(query); const data = await getHistoryStation(slug, filters, typeof query.scenario === "string" ? query.scenario : undefined); if (data === null) notFound(); const messages = getMessages(lang); return <HistoryLayout data={data} lang={lang} messages={messages} filterForm={<HistoryFiltersForm filters={filters} lang={lang} messages={messages} />} />; }
