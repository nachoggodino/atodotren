"use client";

import * as Ariakit from "@ariakit/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowRight } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { DirectionId, Lang, MatrixCell, MatrixResponse, StationRef } from "@/lib/domain/contracts";
import { DELAY_SEVERITY_THRESHOLDS_SECONDS } from "@/lib/domain/delay-policy";
import { formatDelay, formatMadridTime } from "@/lib/domain/format";
import { matrixCellPresentation } from "@/lib/domain/matrix-presentation";
import type { Messages } from "@/messages/types";
import { SegmentedRadio } from "./segmented-radio";

interface SelectedCell {
  readonly cell: MatrixCell;
  readonly station: StationRef;
}

const MATRIX_HEADER_HEIGHT = 52;
const MATRIX_ROW_HEIGHT = 26;
const MATRIX_CELL_SIZE = 26;
const MATRIX_TIME_WIDTH = 45;
const MATRIX_MAX_GRADIENT_DELAY_SECONDS = 1_800;

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

function colorMix(from: string, to: string, progress: number): string {
  const fromPercent = Math.round((1 - Math.max(0, Math.min(1, progress))) * 100);
  return `color-mix(in srgb, ${from} ${fromPercent}%, ${to})`;
}

function matrixCellColor(cell: MatrixCell): string {
  const kind = matrixCellPresentation(cell).kind;
  if (kind === "canceled") return "var(--matrix-canceled)";
  if (kind === "pending" || kind === "missing" || kind === "skipped" || cell.delaySeconds === null) return "var(--matrix-pending)";
  const delay = cell.delaySeconds;
  const { mild, delayed, severe } = DELAY_SEVERITY_THRESHOLDS_SECONDS;
  if (delay <= 0) return "var(--matrix-delay-green)";
  if (delay <= mild) return colorMix("var(--matrix-delay-green)", "var(--matrix-delay-yellow)", delay / mild);
  if (delay <= delayed) return colorMix("var(--matrix-delay-yellow)", "var(--matrix-delay-orange)", (delay - mild) / (delayed - mild));
  if (delay <= severe) return colorMix("var(--matrix-delay-orange)", "var(--matrix-delay-red)", (delay - delayed) / (severe - delayed));
  if (delay <= MATRIX_MAX_GRADIENT_DELAY_SECONDS) return colorMix("var(--matrix-delay-red)", "var(--matrix-delay-burgundy)", (delay - severe) / (MATRIX_MAX_GRADIENT_DELAY_SECONDS - severe));
  return "var(--matrix-delay-burgundy)";
}

function matrixStateLabel(cell: MatrixCell, messages: Messages): string {
  switch (matrixCellPresentation(cell).kind) {
    case "canceled": return messages.history.canceled;
    case "skipped": return messages.history.skipped;
    case "missing": return messages.common.missing;
    case "pending": return messages.history.pending;
    case "early": return messages.history.early;
    case "punctual": return messages.history.punctual;
    case "mild":
    case "delayed": return messages.history.delayed;
    case "severe": return messages.history.severe;
  }
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
  // TanStack Virtual is intentionally compiler-incompatible; this component owns its virtualizer state directly.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: journeys.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => MATRIX_ROW_HEIGHT,
    overscan: 6,
    scrollMargin: MATRIX_HEADER_HEIGHT,
  });
  const gridColumns = `${MATRIX_TIME_WIDTH}px repeat(${stations.length}, ${MATRIX_CELL_SIZE}px)`;

  return (
    <Ariakit.PopoverProvider open={selected !== null} setOpen={(open) => { if (!open) setSelected(null); }} placement="top">
      <div>
        {directions.length > 1 ? (
          <div className="mb-2">
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

        <div aria-colcount={stations.length + 1} aria-label={messages.live.dailyMatrix} aria-rowcount={journeys.length + 1} className="max-h-[65vh] overflow-auto" data-testid="live-daily-matrix" ref={scrollRef} role="grid">
          <div className="sticky top-0 z-20 grid w-max bg-background pr-6" role="row" aria-rowindex={1} style={{ gridTemplateColumns: gridColumns, height: MATRIX_HEADER_HEIGHT }}>
            <span aria-colindex={1} aria-label={messages.live.expectedTime} role="columnheader" />
            {stations.map((station, index) => (
              <div aria-colindex={index + 2} className="relative" data-testid="live-matrix-station-label" key={`header-${station.id}`} role="columnheader" style={{ height: MATRIX_HEADER_HEIGHT, width: MATRIX_CELL_SIZE }} title={station.name[lang]}>
                <span className="absolute bottom-1 left-1/2 block w-16 origin-bottom-left -rotate-45 truncate whitespace-nowrap text-[8px] font-semibold leading-none text-muted">
                  {station.name[lang]}
                </span>
              </div>
            ))}
          </div>
          <div className="relative w-max pr-6" style={{ height: rowVirtualizer.getTotalSize(), minWidth: `${MATRIX_TIME_WIDTH + stations.length * MATRIX_CELL_SIZE}px` }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const journey = journeys[virtualRow.index]!;
              const rowCells = stations.map((station) => cells.get(`${journey.id}:${station.id}`));
              const departure = rowCells.find((cell): cell is MatrixCell => cell !== undefined);
              return (
                <div
                  aria-rowindex={virtualRow.index + 2}
                  className="absolute left-0 top-0 grid w-max items-center"
                  data-testid="live-matrix-virtual-row"
                  key={journey.id}
                  role="row"
                  style={{ gridTemplateColumns: gridColumns, height: virtualRow.size, transform: `translateY(${virtualRow.start - MATRIX_HEADER_HEIGHT}px)` }}
                >
                  <span aria-colindex={1} className="pr-1 text-right font-mono text-[10px] font-semibold tabular-nums text-muted" data-testid="live-matrix-time-label" role="rowheader">
                    {departure === undefined ? "—" : formatMadridTime(departure.scheduledAt, lang)}
                  </span>
                  {stations.map((station, index) => {
                    const cell = rowCells[index];
                    if (cell === undefined) return <span aria-colindex={index + 2} aria-label={`${station.name[lang]}, ${messages.common.noData}`} key={station.id} role="gridcell" style={{ height: MATRIX_CELL_SIZE, width: MATRIX_CELL_SIZE }} />;
                    const stationRef = stationById.get(cell.stationId) ?? station;
                    const active = selected?.cell.journeyId === cell.journeyId && selected.cell.stationId === cell.stationId;
                    const cornerClass = [
                      virtualRow.index === 0 && index === 0 ? "rounded-tl-md" : "",
                      virtualRow.index === 0 && index === stations.length - 1 ? "rounded-tr-md" : "",
                      virtualRow.index === journeys.length - 1 && index === 0 ? "rounded-bl-md" : "",
                      virtualRow.index === journeys.length - 1 && index === stations.length - 1 ? "rounded-br-md" : "",
                    ].filter(Boolean).join(" ");
                    return (
                      <span aria-colindex={index + 2} key={station.id} role="gridcell" style={{ height: MATRIX_CELL_SIZE, width: MATRIX_CELL_SIZE }}>
                        <Ariakit.PopoverDisclosure
                          aria-label={`${stationRef.name[lang]}, ${formatMadridTime(cell.scheduledAt, lang)}, ${matrixStateLabel(cell, messages)}, ${formatDelay(cell.delaySeconds, lang)}`}
                          className={`relative h-full w-full touch-manipulation outline-none transition-[filter,opacity] hover:brightness-110 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-0 ${cornerClass}`}
                          data-kind={matrixCellPresentation(cell).kind}
                          data-selected={active ? "true" : "false"}
                          onClick={() => setSelected({ cell, station: stationRef })}
                          style={{ backgroundColor: matrixCellColor(cell) }}
                          type="button"
                        >
                          {active ? <span aria-hidden="true" className="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground" data-testid="live-matrix-selected-dot" /> : null}
                        </Ariakit.PopoverDisclosure>
                      </span>
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
              <div className="flex items-baseline justify-between gap-4"><dt className="text-muted">{messages.common.state}</dt><dd className="font-bold capitalize">{matrixStateLabel(selected.cell, messages)}</dd></div>
              <div className="flex items-baseline justify-between gap-4"><dt className="text-muted">{messages.live.expectedTime}</dt><dd className="font-mono font-bold">{formatMadridTime(selected.cell.scheduledAt, lang)}</dd></div>
              <div className="flex items-baseline justify-between gap-4"><dt className="text-muted">{messages.live.delay}</dt><dd className="font-bold">{formatDelay(selected.cell.delaySeconds, lang)}</dd></div>
            </dl>
          </div>
        )}
      </Ariakit.Popover>
    </Ariakit.PopoverProvider>
  );
}
