"use client";

import { Grid3X3, Map as MapIcon, TrainFront } from "lucide-react";
import { useMemo, useState } from "react";
import type { DirectionId, Lang, MatrixResponse, SchematicPattern, TrainDetail } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";
import { DailyDelayMatrix } from "./daily-delay-matrix";
import { SchematicMap } from "./schematic-map";

type ViewMode = "schematic" | "matrix";

export function LiveLineVisualization({
  patterns,
  trains,
  matrix,
  lineColor,
  lang,
  messages,
}: {
  readonly patterns: readonly SchematicPattern[];
  readonly trains: readonly TrainDetail[];
  readonly matrix: MatrixResponse | null;
  readonly lineColor: string;
  readonly lang: Lang;
  readonly messages: Messages;
}) {
  const [mode, setMode] = useState<ViewMode>("schematic");
  const directionByJourney = useMemo(() => {
    const result = new Map<string, DirectionId>();
    if (matrix === null) return result;
    for (const journey of matrix.journeys) {
      if (journey.direction !== null) result.set(journey.id, journey.direction.id);
    }
    return result;
  }, [matrix]);

  return (
    <div data-testid="live-line-visualization">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted" data-testid="live-active-trains">
        <TrainFront aria-hidden="true" className="size-4" />
        <span>{trains.length} {messages.live.activeTrains}</span>
      </div>

      <div aria-label={messages.live.viewMode} className="grid grid-cols-2 gap-2" role="radiogroup">
        <button
          aria-checked={mode === "schematic"}
          className={`flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-bold transition-[background-color,color,transform,opacity] active:scale-[.98] active:opacity-75 ${mode === "schematic" ? "bg-muted-soft text-primary" : "text-muted hover:bg-muted-soft"}`}
          onClick={() => setMode("schematic")}
          role="radio"
          type="button"
        >
          <MapIcon aria-hidden="true" className="size-4" />
          {messages.live.schematic}
        </button>
        <button
          aria-checked={mode === "matrix"}
          className={`flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-bold transition-[background-color,color,transform,opacity] active:scale-[.98] active:opacity-75 ${mode === "matrix" ? "bg-muted-soft text-primary" : "text-muted hover:bg-muted-soft"}`}
          onClick={() => setMode("matrix")}
          role="radio"
          type="button"
        >
          <Grid3X3 aria-hidden="true" className="size-4" />
          {messages.live.dailyMatrix}
        </button>
      </div>

      <div className="mt-3">
        {mode === "schematic" ? (
          patterns.length === 0
            ? <p className="border-y border-border py-6 text-sm text-muted">{messages.common.noData}</p>
            : <SchematicMap patterns={patterns} trains={trains} directionByJourney={directionByJourney} lineColor={lineColor} lang={lang} messages={messages} />
        ) : matrix === null ? (
          <p className="border-y border-border py-6 text-sm text-muted">{messages.history.matrixNoData}</p>
        ) : (
          <DailyDelayMatrix matrix={matrix} lang={lang} messages={messages} />
        )}
      </div>
    </div>
  );
}
