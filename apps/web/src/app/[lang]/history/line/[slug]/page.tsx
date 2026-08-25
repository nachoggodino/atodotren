import { notFound } from "next/navigation";
import { HistoryFiltersForm } from "@/components/history/history-filters";
import { HistoryLayout } from "@/components/history/history-layout";
import { InvalidHistoryFilters } from "@/components/history/invalid-filters";
import { TimetableMatrix } from "@/components/history/timetable-matrix";
import type { MatrixResult } from "@/lib/domain/contracts";
import { tryHistoryFiltersFromPage, type PageSearchParams } from "@/lib/domain/page-params";
import { getMessages, isLang } from "@/lib/i18n";
import { getHistoryLine, getMatrix } from "@/lib/server/services";

export const dynamic = "force-dynamic";

function matrixView(result: MatrixResult, lang: "es" | "en", messages: ReturnType<typeof getMessages>) {
  if (result.status === "available") return <TimetableMatrix matrix={result.matrix} lang={lang} messages={messages} />;
  if (result.status === "failed") return <p className="border-y border-border py-8 text-sm text-danger">{messages.history.matrixFailed}</p>;
  if (result.reason === "retention") return <p className="border-y border-border py-8 text-sm text-muted">{messages.history.matrixRetention}</p>;
  return <p className="border-y border-border py-8 text-sm text-muted">{messages.history.matrixNoData}</p>;
}

export default async function HistoryLinePage({ params, searchParams }: { readonly params: Promise<{ lang: string; slug: string }>; readonly searchParams: Promise<PageSearchParams> }) {
  const [{ lang, slug }, query] = await Promise.all([params, searchParams]);
  if (!isLang(lang)) notFound();
  const messages = getMessages(lang);
  const parsed = tryHistoryFiltersFromPage(query);
  if (!parsed.ok) return <InvalidHistoryFilters messages={messages} />;
  const scenario = typeof query.scenario === "string" ? query.scenario : undefined;
  const [data, matrix] = await Promise.all([getHistoryLine(slug, parsed.filters, scenario), getMatrix(slug, parsed.filters.to, scenario)]);
  if (data === null) notFound();
  return <HistoryLayout data={data} lang={lang} messages={messages} filterForm={<HistoryFiltersForm filters={parsed.filters} directions={data.directions} lang={lang} messages={messages} />} matrix={matrixView(matrix, lang, messages)} />;
}
