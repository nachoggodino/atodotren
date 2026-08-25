import { CheckCircle2, Clock3, Database, Gauge } from "lucide-react";
import type { Lang, ResponseMeta } from "@/lib/domain/contracts";
import { formatMadridTime, formatPercent } from "@/lib/domain/format";
import { freshnessLabel, precisionLabel, sourceStatusLabel } from "@/lib/i18n/domain-labels";
import type { Messages } from "@/messages/types";

function finalizationLabel(meta: ResponseMeta, messages: Messages): string {
  switch (meta.finalization.state) {
    case "finalized": return messages.common.finalized;
    case "processing": return messages.common.processing;
    case "unknown": return messages.common.finalizationUnknown;
  }
}

function provenanceLabel(meta: ResponseMeta, messages: Messages): string {
  switch (meta.provenance.kind) {
    case "none": return messages.common.algorithmNone;
    case "single": return meta.provenance.version;
    case "mixed": return `${messages.common.algorithmMixed}: ${meta.provenance.versions.join(", ")}`;
  }
}

export function DataMeta({ meta, lang, messages }: { readonly meta: ResponseMeta; readonly lang: Lang; readonly messages: Messages }) {
  const sourceAt = meta.source.freshness.sourceAt;
  return <div className="flex flex-wrap gap-x-5 gap-y-2 border-y border-border py-3 text-xs text-muted" aria-label={messages.common.dataMetadata}>
    <span className="data-status text-foreground" data-status={meta.source.status}>{sourceStatusLabel(meta.source.status, messages)}</span>
    <span className="flex items-center gap-1.5"><Clock3 className="size-3.5" />{messages.common.updated}: {formatMadridTime(sourceAt, lang, true)} · {freshnessLabel(meta.source.freshness.state, messages)}</span>
    <span className="flex items-center gap-1.5"><Gauge className="size-3.5" />{messages.common.coverage}: {formatPercent(meta.coverage.ratio)}</span>
    <span className="flex items-center gap-1.5"><CheckCircle2 className="size-3.5" />{finalizationLabel(meta, messages)}</span>
    <span className="flex items-center gap-1.5"><Database className="size-3.5" />{messages.common.precision}: {precisionLabel(meta.precision, messages)} · {provenanceLabel(meta, messages)}</span>
  </div>;
}
