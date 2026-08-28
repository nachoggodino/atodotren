import { DataMeta } from "@/components/feedback/data-meta";
import type { Lang, ResponseMeta, SummaryStats } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";
import { LiveHeader } from "./live-header";
import { LiveRefresh } from "./live-refresh";
import { LiveStatsBand } from "./live-stats-band";

export function LivePageSummary({ meta, stats, lang, messages, title, subtitle, backLabel, contextColor }: { readonly meta: ResponseMeta; readonly stats: SummaryStats; readonly lang: Lang; readonly messages: Messages; readonly title: string; readonly subtitle: string; readonly backLabel?: string; readonly contextColor?: string }) {
  return (
    <>
      <LiveHeader backLabel={backLabel} contextColor={contextColor} lang={lang} messages={messages} subtitle={subtitle} title={title} />
      <div className="mt-5"><DataMeta meta={meta} lang={lang} messages={messages} variant="live" /><LiveRefresh messages={messages} /></div>
      <div className="mt-6"><LiveStatsBand stats={stats} lang={lang} messages={messages} /></div>
    </>
  );
}
