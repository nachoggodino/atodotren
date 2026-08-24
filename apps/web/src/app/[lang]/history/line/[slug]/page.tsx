import { notFound } from "next/navigation";
import { HistoryFiltersForm } from "@/components/history/history-filters";
import { HistoryLayout } from "@/components/history/history-layout";
import { TimetableMatrix } from "@/components/history/timetable-matrix";
import { historyFiltersFromPage, type PageSearchParams } from "@/lib/domain/page-params";
import { getMessages, isLang } from "@/lib/i18n";
import { getHistoryLine, getMatrix } from "@/lib/server/services";

export const dynamic = "force-dynamic";
export default async function HistoryLinePage({ params, searchParams }: { readonly params: Promise<{ lang: string; slug: string }>; readonly searchParams: Promise<PageSearchParams> }) { const [{ lang, slug }, query] = await Promise.all([params, searchParams]); if (!isLang(lang)) notFound(); const filters = historyFiltersFromPage(query); const scenario = typeof query.scenario === "string" ? query.scenario : undefined; const [data, matrix] = await Promise.all([getHistoryLine(slug, filters, scenario), getMatrix(slug, filters.to, scenario).catch(() => null)]); if (data === null) notFound(); const messages = getMessages(lang); return <HistoryLayout data={data} lang={lang} messages={messages} filterForm={<HistoryFiltersForm filters={filters} lang={lang} messages={messages} />} matrix={matrix === null ? <p className="border-y border-border py-8 text-sm text-muted">{lang === "es" ? "La matriz detallada solo está disponible durante la ventana de retención de 30 días." : "Detailed matrix data is only available inside the 30-day retention window."}</p> : <TimetableMatrix matrix={matrix} lang={lang} messages={messages} />} />; }
