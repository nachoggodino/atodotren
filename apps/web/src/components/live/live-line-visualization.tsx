"use client";

import { Grid3X3, Map as MapIcon, TrainFront } from "lucide-react";
import { useMemo, useState } from "react";
import type { DirectionId, Lang, MatrixResult, SchematicPattern, TrainDetail } from "@/lib/domain/contracts";
import { matrixResultMessage } from "@/lib/domain/matrix-result";
import type { Messages } from "@/messages/types";
import { DailyDelayMatrix } from "./daily-delay-matrix";
import { SchematicMap } from "./schematic-map";
import { SegmentedRadio } from "./segmented-radio";

type ViewMode = "schematic" | "matrix";

export function LiveLineVisualization({ patterns, trains, matrixResult, lineColor, lang, messages }: { readonly patterns: readonly SchematicPattern[]; readonly trains: readonly TrainDetail[]; readonly matrixResult: MatrixResult | null; readonly lineColor: string; readonly lang: Lang; readonly messages: Messages }) {
  const [mode, setMode] = useState<ViewMode>("schematic");
  const matrix = matrixResult?.status === "available" ? matrixResult.matrix : null;
  const matrixMessage = matrixResultMessage(matrixResult, messages);
  const directionByJourney = useMemo(() => {
    const result = new Map<string, DirectionId>();
    if (matrix === null) return result;
    for (const journey of matrix.journeys) if (journey.direction !== null) result.set(journey.id, journey.direction.id);
    return result;
  }, [matrix]);

  return (
    <div data-testid="live-line-visualization">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted" data-testid="live-active-trains"><TrainFront aria-hidden="true" className="size-4 text-[var(--landing-positive)]" /><span>{trains.length} {messages.live.activeTrains}</span></div>
      <SegmentedRadio
        label={messages.live.viewMode}
        name="live-line-view"
        onChange={(value) => setMode(value)}
        options={[
          { value: "schematic", label: messages.live.schematic, icon: <MapIcon aria-hidden="true" className="size-4 shrink-0" /> },
          { value: "matrix", label: messages.live.dailyMatrix, icon: <Grid3X3 aria-hidden="true" className="size-4 shrink-0" /> },
        ]}
        value={mode}
      />
      <div className="mt-3">
        {mode === "schematic" ? (
          patterns.length === 0 ? <p className="border-y border-border py-6 text-sm text-muted">{messages.common.noData}</p> : <SchematicMap patterns={patterns} trains={trains} directionByJourney={directionByJourney} lineColor={lineColor} lang={lang} messages={messages} />
        ) : matrix === null ? (
          <p className={`border-y border-border py-6 text-sm ${matrixResult?.status === "failed" ? "text-danger" : "text-muted"}`}>{matrixMessage ?? messages.history.matrixNoData}</p>
        ) : <DailyDelayMatrix matrix={matrix} lang={lang} messages={messages} />}
      </div>
    </div>
  );
}
