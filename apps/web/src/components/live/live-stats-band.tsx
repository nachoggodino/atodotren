import type { Lang, SummaryStats } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";
import { SummaryStatsCard, type SummaryMetricHelp } from "@/components/summary-stats-card";
import type { SummaryMetricKey } from "./summary-metrics";

export type LiveStatsContext = "network" | "line" | "station";

function metricHelp(messages: Messages, context: LiveStatsContext): SummaryMetricHelp {
  if (context === "line") {
    return {
      punctuality: messages.live.linePunctualityHelp,
      coverage: messages.live.lineCoverageHelp,
      mean: messages.live.lineMeanHelp,
      median: messages.live.lineMedianHelp,
    };
  }
  if (context === "station") {
    return {
      punctuality: messages.live.stationPunctualityHelp,
      coverage: messages.live.stationCoverageHelp,
      mean: messages.live.stationMeanHelp,
      median: messages.live.stationMedianHelp,
    };
  }
  return {
    punctuality: messages.live.punctualityHelp,
    coverage: messages.live.coverageHelp,
    mean: messages.live.meanHelp,
    median: messages.live.medianHelp,
  } satisfies Readonly<Record<SummaryMetricKey, string>>;
}

export function LiveStatsBand({ stats, lang, messages, context }: { readonly stats: SummaryStats; readonly lang: Lang; readonly messages: Messages; readonly context: LiveStatsContext }) {
  return <SummaryStatsCard help={metricHelp(messages, context)} lang={lang} messages={messages} stats={stats} testId="live-stats-grid" />;
}
