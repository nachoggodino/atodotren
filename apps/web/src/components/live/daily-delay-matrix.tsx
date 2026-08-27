"use client";

import * as Ariakit from "@ariakit/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowRight } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { MatrixLegend } from "@/components/matrix/matrix-legend";
import type { DirectionId, Lang, MatrixCell, MatrixResponse, StationRef } from "@/lib/domain/contracts";
import { formatDelay, formatMadridTime } from "@/lib/domain/format";
import { matrixCellPresentation } from "@/lib/domain/matrix-presentation";
import type { Messages } from "@/messages/types";
import { SegmentedRadio } from "./segmented-radio";

interface SelectedCell {
  readonly cell: MatrixCell;
  readonly station: StationRef;
}

const MATRIX_HEADER_HEIGHT = 64;
const MATRIX_ROW_HEIGHT = 36;

function directionIds(matrix: MatrixResponse): readonly DirectionId[] {
  const values = new Set<DirectionId>();
  for (const journey of matrix.journeys) if (journey.direction !== null) values.add(journey.direction.id);
  return [...values].sort((left, right) => left - right);
}

function stationsForDirection(matrix: MatrixResponse, direction: DirectionId): readonly StationRef[] {
  const representative = matrix.journeys.find((journey) => journey.direction?.id === direction);
  if (representative === undefined) return matrix.stations;
  const stationById = new Map(matrix.stations.map((station) => [station.id, station]));
  const ordered = matrix.cells
    .filter((cell) => cell.journeyId === representative.id)
    .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt))
    .flatMap((cell) => {
      const station = stationById.get(cell.stationId);
      return station === undefined ? [] : [station];
    });
  const seen = new Set(ordered.map((station) => station.id));
  return [...ordered, ...matrix.stations.filter((station) => !seen.has(station.id))];
}

function directionLabel(direction: DirectionId, matrix: MatrixResponse, lang: Lang, messages: Messages): string {
  const representative = matrix.journeys.find((journey) => journey.direction?.id === direction);
  if (representative === undefined) return direction === 0 ? messages.common.directionA : messages.common.directionB;
  const destination = representative.direction?.to;
  if (destination !== null && destination !== undefined) return `${messages.live.towards} ${destination.name[lang]}`;
  const destinationCell = matrix.cells
    .filter((cell) => cell.journeyId === representative.id)
    .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt))
    .at(-1);
  const fallback = destinationCell === undefined ? undefined : matrix.stations.find((station) => station.id === destinationCell.stationId);
  return fallback === undefined ? (direction === 0 ? messages.common.directionA : messages.common.directionB) : `${messages.live.towards} ${fallback.name[lang]}`;
}

function stationLabel(value: string): string {
  return value.length > 17 ? `${value.slice(0, 16)}…` : value;
}

export function DailyDelayMatrix({ matrix, lang, messages }: { readonly matrix: MatrixResponse; readonly lang: Lang; readonly messages: Messages }) {
  const directions = useMemo(() => directionIds(matrix), [matrix]);
  const [selectedDirection, setSelectedDirection] = useState<DirectionId>(directions[0] ?? 0);
  const [selected, setSelected] = useState<SelectedCell | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstCellByJourney = useMemo(() => {
    const result = new Map<string, MatrixCell>();
    for (const cell of matrix.cells) {
      const current = result.get(cell.journeyId);
      if (current === undefined || cell.scheduledAt < current.scheduledAt) result.set(cell.journeyId, cell);
    }
    return result;
  }, [matrix.cells]);
  const journeys = useMemo(
    () => matrix.journeys
      .filter((journey) => journey.direction?.id === selectedDirection)
      .sort((left, right) => (firstCellByJourney.get(left.id)?.scheduledAt ?? "").localeCompare(firstCellByJourney.get(right.id)?.scheduledAt ?? "")),
    [firstCellByJourney, matrix.journeys, selectedDirection],
  );
  const stations = useMemo(() => stationsForDirection(matrix, selectedDirection), [matrix, selectedDirection]);
  const cells = useMemo(() => new Map(matrix.cells.map((cell) => [`${cell.journeyId}:${cell.stationId}`, cell])), [matrix.cells]);
  const stationById = useMemo(() => new Map(matrix.stations.map((station) => [station.id, station])), [matrix.stations]);
  const rowVirtualizer = useVirtualizer({
    count: journeys.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => MATRIX_ROW_HEIGHT,
    overscan: 6,
    scrollMargin: MATRIX_HEADER_HEIGHT,
  });
  const gridColumns = `3.5rem repeat(${stations.length}, 2rem)`;

  return (
    <Ariakit.PopoverProvider open={selected !== null} setOpen={(open) => { if (!open) setSelected(null); }} placement="top">
      <div>
        {directions.length > 1 ? (
          <div className="mb-3">
            <SegmentedRadio
              compact
              label={messages.common.direction}
              name="live-matrix-direction"
              onChange={(direction) => { setSelected(null); setSelectedDirection(direction); }}
              options={directions.map((direction) => ({
                value: direction,
                label: directionLabel(direction, matrix, lang, messages),
                icon: <ArrowRight aria-hidden="true" className="size-2.5 shrink-0" />,
              }))}
              testId="live-matrix-directions"
              value={selectedDirection}
            />
          </div>
        ) : null}
        <MatrixLegend messages={messages} />

        <div className="max-h-[65vh] overflow-auto rounded-lg border border-border" data-testid="live-daily-matrix" ref={scrollRef}>
          <div className="sticky top-0 z-20 grid w-max gap-px border-b border-border bg-surface-strong pr-8" style={{ gridTemplateColumns: gridColumns, height: MATRIX_HEADER_HEIGHT }}>
            <span aria-hidden="true" />
            {stations.map((station) => (
              <div className="relative h-16 w-8" data-testid="live-matrix-station-label" key={`header-${station.id}`} title={station.name[lang]}>
                <span className="absolute bottom-1 left-1/2 block w-20 origin-bottom-left -rotate-45 truncate whitespace-nowrap text-[8px] font-semibold leading-none text-muted">
                  {stationLabel(station.name[lang])}
                </span>
              </div>
            ))}
          </div>
          <div className="relative w-max pr-8" style={{ height: rowVirtualizer.getTotalSize(), minWidth: `calc(3.5rem + ${stations.length * 2}rem)` }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const journey = journeys[virtualRow.index]!;
              const rowCells = stations.map((station) => cells.get(`${journey.id}:${station.id}`));
              const departure = rowCells.find((cell): cell is MatrixCell => cell !== undefined);
              return (
                <div
                  className="absolute left-0 top-0 grid w-max items-center gap-px"
                  data-testid="live-matrix-virtual-row"
                  key={journey.id}
                  style={{ gridTemplateColumns: gridColumns, height: virtualRow.size, transform: `translateY(${virtualRow.start - MATRIX_HEADER_HEIGHT}px)` }}
                >
                  <span className="pr-1 text-right font-mono text-[10px] font-semibold tabular-nums text-muted">
                    {departure === undefined ? "—" : formatMadridTime(departure.scheduledAt, lang)}
                  </span>
                  {stations.map((station, index) => {
                    const cell = rowCells[index];
                    if (cell === undefined) return <span aria-hidden="true" className="size-8" key={station.id} />;
                    const stationRef = stationById.get(cell.stationId) ?? station;
                    const active = selected?.cell.journeyId === cell.journeyId && selected.cell.stationId === cell.stationId;
                    const presentation = matrixCellPresentation(cell);
                    return (
                      <Ariakit.PopoverDisclosure
                        aria-label={`${stationRef.name[lang]}, ${formatMadridTime(cell.scheduledAt, lang)}, ${formatDelay(cell.delaySeconds, lang)}`}
                        className="matrix-compact-cell relative grid size-8 touch-manipulation place-items-center rounded-[3px] text-[9px] font-black outline-none transition-[transform,box-shadow] hover:scale-110 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--background)]"
                        data-kind={presentation.kind}
                        data-selected={active ? "true" : "false"}
                        key={station.id}
                        onClick={() => setSelected({ cell, station: stationRef })}
                        type="button"
                      >
                        <span aria-hidden="true">{presentation.symbol}</span>
                      </Ariakit.PopoverDisclosure>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <Ariakit.Popover className="z-[80] min-w-48 rounded-xl border border-border bg-surface-strong p-3 shadow-[var(--shadow-float)] outline-none" gutter={7} portal data-testid="live-matrix-detail">
        {selected === null ? null : (
          <div className="text-sm">
            <p className="font-black">{selected.station.name[lang]}</p>
            <dl className="mt-2 grid gap-1.5">
              <div className="flex items-baseline justify-between gap-4"><dt className="text-muted">{messages.live.expectedTime}</dt><dd className="font-mono font-bold">{formatMadridTime(selected.cell.scheduledAt, lang)}</dd></div>
              <div className="flex items-baseline justify-between gap-4"><dt className="text-muted">{messages.live.delay}</dt><dd className="font-bold">{formatDelay(selected.cell.delaySeconds, lang)}</dd></div>
            </dl>
          </div>
        )}
      </Ariakit.Popover>
    </Ariakit.PopoverProvider>
  );
}
