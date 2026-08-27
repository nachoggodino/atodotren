"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { Lang, MatrixCell, MatrixResponse } from "@/lib/domain/contracts";
import { formatDelay, formatMadridTime } from "@/lib/domain/format";
import { matrixCellPresentation } from "@/lib/domain/matrix-presentation";
import { evidenceLabel } from "@/lib/i18n/domain-labels";
import type { Messages } from "@/messages/types";
import { MatrixLegend } from "@/components/matrix/matrix-legend";

const STATION_COLUMN_WIDTH = 176;
const JOURNEY_COLUMN_WIDTH = 96;
const ROW_HEIGHT = 58;

export function TimetableMatrix({ matrix, lang, messages }: { readonly matrix: MatrixResponse; readonly lang: Lang; readonly messages: Messages }) {
  const [selected, setSelected] = useState<MatrixCell | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cells = useMemo(() => new Map(matrix.cells.map((cell) => [`${cell.stationId}:${cell.journeyId}`, cell])), [matrix.cells]);
  // TanStack Virtual is intentionally compiler-incompatible; this component owns its virtualizer state directly.
  // eslint-disable-next-line react-hooks/incompatible-library
  const journeyVirtualizer = useVirtualizer({
    count: matrix.journeys.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => JOURNEY_COLUMN_WIDTH,
    horizontal: true,
    overscan: 3,
  });
  const virtualJourneys = journeyVirtualizer.getVirtualItems();
  const matrixWidth = STATION_COLUMN_WIDTH + journeyVirtualizer.getTotalSize();

  return (
    <div>
      <MatrixLegend messages={messages} />
      <div className="max-h-[70vh] overflow-auto rounded-xl border border-border" data-testid="timetable-matrix" ref={scrollRef}>
        <div className="relative min-w-max text-xs" style={{ width: matrixWidth }}>
          <div className="sticky top-0 z-20 h-12 border-b border-border bg-surface-strong">
            <div className="sticky left-0 z-30 grid h-12 place-items-center border-r border-border bg-surface-strong px-3 text-left font-bold" style={{ width: STATION_COLUMN_WIDTH }}>
              <span className="w-full">{messages.history.stationColumn}</span>
            </div>
            {virtualJourneys.map((virtualJourney) => {
              const journey = matrix.journeys[virtualJourney.index]!;
              return (
                <div
                  className="absolute top-0 grid h-12 place-items-center border-l border-border px-2 text-center font-bold"
                  data-testid="matrix-virtual-column"
                  key={journey.id}
                  style={{ left: STATION_COLUMN_WIDTH + virtualJourney.start, width: virtualJourney.size }}
                >
                  {journey.label}
                </div>
              );
            })}
          </div>
          {matrix.stations.map((station) => (
            <div className="relative border-b border-border last:border-b-0" key={station.id} style={{ height: ROW_HEIGHT }}>
              <div className="sticky left-0 z-10 flex h-full items-center border-r border-border bg-surface-strong px-3 font-bold whitespace-normal" style={{ width: STATION_COLUMN_WIDTH }}>
                {station.name[lang]}
              </div>
              {virtualJourneys.map((virtualJourney) => {
                const journey = matrix.journeys[virtualJourney.index]!;
                const cell = cells.get(`${station.id}:${journey.id}`);
                if (cell === undefined) {
                  return (
                    <span
                      aria-hidden="true"
                      className="absolute top-0 grid h-full place-items-center border-l border-border text-muted"
                      key={journey.id}
                      style={{ left: STATION_COLUMN_WIDTH + virtualJourney.start, width: virtualJourney.size }}
                    >·</span>
                  );
                }
                const presentation = matrixCellPresentation(cell);
                return (
                  <button
                    aria-label={`${station.name[lang]}, ${formatMadridTime(cell.scheduledAt, lang)}, ${evidenceLabel(cell.state, messages)}, ${formatDelay(cell.delaySeconds, lang)}`}
                    className="matrix-cell absolute top-0 grid h-full place-items-center gap-0.5 border-l border-border px-2 text-center outline-none hover:ring-2 hover:ring-inset hover:ring-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                    data-kind={presentation.kind}
                    data-state={cell.state}
                    key={journey.id}
                    onClick={() => setSelected(cell)}
                    style={{ left: STATION_COLUMN_WIDTH + virtualJourney.start, width: virtualJourney.size }}
                    type="button"
                  >
                    <strong className="font-mono text-[11px]">{formatMadridTime(cell.scheduledAt, lang)}</strong>
                    <span aria-hidden="true" className="font-black">{presentation.symbol}</span>
                    <span className="sr-only">{evidenceLabel(cell.state, messages)}, {formatDelay(cell.delaySeconds, lang)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {selected ? (
        <div className="mt-3 flex items-start justify-between gap-4 rounded-lg border border-border bg-surface-strong p-4" data-testid="matrix-detail">
          <div>
            <p className="eyebrow">{messages.common.details}</p>
            <p className="mt-1 font-bold">{formatMadridTime(selected.scheduledAt, lang)} · {evidenceLabel(selected.state, messages)}</p>
            <p className="mt-1 text-sm text-muted">{formatDelay(selected.delaySeconds, lang)}</p>
          </div>
          <button className="grid size-11 place-items-center rounded-md hover:bg-muted-soft" onClick={() => setSelected(null)} aria-label={messages.nav.close} type="button">
            <X className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
