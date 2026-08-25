import { notFound } from "next/navigation";
import { HistoryFiltersForm } from "@/components/history/history-filters";
import { HistoryLayout } from "@/components/history/history-layout";
import { getMessages, isLang } from "@/lib/i18n";
import { historyFiltersFromPage, type PageSearchParams } from "@/lib/domain/page-params";
import { getHistoryNetwork } from "@/lib/server/services";

export const dynamic = "force-dynamic";
export default async function HistoryPage({ params, searchParams }: { readonly params: Promise<{ lang: string }>; readonly searchParams: Promise<PageSearchParams> }) { const [{ lang }, query] = await Promise.all([params, searchParams]); if (!isLang(lang)) notFound(); const filters = historyFiltersFromPage(query); const messages = getMessages(lang); const data = await getHistoryNetwork(filters, typeof query.scenario === "string" ? query.scenario : undefined); return <HistoryLayout data={data} lang={lang} messages={messages} filterForm={<HistoryFiltersForm filters={filters} messages={messages} />} />; }
