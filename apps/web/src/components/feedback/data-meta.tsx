import { CheckCircle2, Clock3, Database, Gauge } from "lucide-react";
import type { Lang, ResponseMeta } from "@/lib/domain/contracts";
import { formatPercent, statusLabel } from "@/lib/domain/format";
import type { Messages } from "@/messages/types";

export function DataMeta({ meta, lang, messages }: { readonly meta: ResponseMeta; readonly lang: Lang; readonly messages: Messages }) {
  const source = meta.sourceAt === null ? "—" : new Intl.DateTimeFormat(lang === "es" ? "es-ES" : "en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Europe/Madrid" }).format(new Date(meta.sourceAt));
  return <div className="flex flex-wrap gap-x-5 gap-y-2 border-y border-border py-3 text-xs text-muted" aria-label={messages.common.dataMetadata}>
    <span className="data-status text-foreground" data-status={meta.status}>{statusLabel(meta.status, lang)}</span>
    <span className="flex items-center gap-1.5"><Clock3 className="size-3.5" />{messages.common.updated}: {source}</span>
    <span className="flex items-center gap-1.5"><Gauge className="size-3.5" />{messages.common.coverage}: {formatPercent(meta.coverage.ratio)}</span>
    <span className="flex items-center gap-1.5"><CheckCircle2 className="size-3.5" />{meta.finalized ? messages.common.finalized : messages.common.unfinalized}</span>
    <span className="flex items-center gap-1.5"><Database className="size-3.5" />{messages.common.precision}: {meta.precision}</span>
  </div>;
}
