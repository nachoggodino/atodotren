import { Archive, CheckCircle2, Clock3, Database, Gauge, Radio, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Lang, ResponseMeta } from "@/lib/domain/contracts";
import { formatMadridTime, formatPercent } from "@/lib/domain/format";
import { coverageStatusLevel, freshnessStatusLevel, precisionStatusLevel, sourceStatusLevel, type LiveStatusLevel } from "@/lib/domain/live-status";
import { freshnessLabel, precisionLabel, sourceStatusLabel } from "@/lib/i18n/domain-labels";
import type { Messages } from "@/messages/types";

function finalizationLabel(meta: ResponseMeta, messages: Messages): string {
  switch (meta.finalization.state) {
    case "finalized": return messages.common.finalized;
    case "processing": return messages.common.processing;
    case "unknown": return messages.common.finalizationUnknown;
  }
}

function finalizationStatusLevel(meta: ResponseMeta): LiveStatusLevel {
  switch (meta.finalization.state) {
    case "finalized": return "good";
    case "processing": return "warning";
    case "unknown": return "unknown";
  }
}

function provenanceLabel(meta: ResponseMeta, messages: Messages): string {
  switch (meta.provenance.kind) {
    case "none": return messages.common.algorithmNone;
    case "single": return meta.provenance.version;
    case "mixed": return `${messages.common.algorithmMixed}: ${meta.provenance.versions.join(", ")}`;
  }
}

function LiveMetaItem({ icon: Icon, tone, children }: { readonly icon: LucideIcon; readonly tone: LiveStatusLevel; readonly children: ReactNode }) {
  return (
    <span className="live-status-item flex min-w-0 items-start gap-2" data-tone={tone}>
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 leading-5">{children}</span>
    </span>
  );
}

export function DataMeta({ meta, lang, messages, variant = "default" }: { readonly meta: ResponseMeta; readonly lang: Lang; readonly messages: Messages; readonly variant?: "default" | "live" | "explore" }) {
  const sourceAt = meta.source.freshness.sourceAt;

  if (variant === "live") {
    return (
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs sm:grid-cols-4" aria-label={messages.common.dataMetadata} data-testid="live-data-meta">
        <LiveMetaItem icon={Radio} tone={sourceStatusLevel(meta.source.status)}>{sourceStatusLabel(meta.source.status, messages)}</LiveMetaItem>
        <LiveMetaItem icon={Clock3} tone={freshnessStatusLevel(meta.source.freshness.state)}>{messages.common.updated}: {formatMadridTime(sourceAt, lang, true)}</LiveMetaItem>
        <LiveMetaItem icon={Gauge} tone={coverageStatusLevel(meta.coverage.ratio)}>{messages.common.coverage}: {formatPercent(meta.coverage.ratio)}</LiveMetaItem>
        <LiveMetaItem icon={Database} tone={precisionStatusLevel(meta.precision)}>{messages.common.precision}: {precisionLabel(meta.precision, messages)}</LiveMetaItem>
      </div>
    );
  }

  if (variant === "explore") {
    return (
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs sm:grid-cols-4" aria-label={messages.common.dataMetadata} data-testid="explore-data-meta">
        <LiveMetaItem icon={Archive} tone={sourceStatusLevel(meta.source.status)}>{sourceStatusLabel(meta.source.status, messages)}</LiveMetaItem>
        <LiveMetaItem icon={CheckCircle2} tone={finalizationStatusLevel(meta)}>{finalizationLabel(meta, messages)}</LiveMetaItem>
        <LiveMetaItem icon={Gauge} tone={coverageStatusLevel(meta.coverage.ratio)}>{messages.common.coverage}: {formatPercent(meta.coverage.ratio)}</LiveMetaItem>
        <LiveMetaItem icon={Database} tone={precisionStatusLevel(meta.precision)}>{messages.common.precision}: {precisionLabel(meta.precision, messages)} · {provenanceLabel(meta, messages)}</LiveMetaItem>
      </div>
    );
  }

  return <div className="flex flex-wrap gap-x-5 gap-y-2 border-y border-border py-3 text-xs text-muted" aria-label={messages.common.dataMetadata}>
    <span className="data-status text-foreground" data-status={meta.source.status}>{sourceStatusLabel(meta.source.status, messages)}</span>
    <span className="flex items-center gap-1.5"><Clock3 className="size-3.5" />{messages.common.updated}: {formatMadridTime(sourceAt, lang, true)} · {freshnessLabel(meta.source.freshness.state, messages)}</span>
    <span className="flex items-center gap-1.5"><Gauge className="size-3.5" />{messages.common.coverage}: {formatPercent(meta.coverage.ratio)}</span>
    <span className="flex items-center gap-1.5"><CheckCircle2 className="size-3.5" />{finalizationLabel(meta, messages)}</span>
    <span className="flex items-center gap-1.5"><Database className="size-3.5" />{messages.common.precision}: {precisionLabel(meta.precision, messages)} · {provenanceLabel(meta, messages)}</span>
  </div>;
}
