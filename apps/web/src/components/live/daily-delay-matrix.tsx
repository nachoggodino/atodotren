"use client";

import * as Ariakit from "@ariakit/react";
import { ArrowRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { DirectionId, Lang, MatrixCell, MatrixResponse, StationRef } from "@/lib/domain/contracts";
import { formatDelay, formatMadridTime } from "@/lib/domain/format";
import type { Messages } from "@/messages/types";

interface SelectedCell {
  readonly cell: MatrixCell;
  readonly station: StationRef;
}

function directionIds(matrix: MatrixResponse): readonly DirectionId[] {
  const values = new Set<DirectionId>();
  for (const journey of matrix.journeys) {
    if (journey.direction !== null) values.add(journey.direction.id);
  }
  return [...values].sort((left, right) => left - right);
}

function cellColor(delaySeconds: number | null): string {
  if (delaySeconds === null) return "var(--unknown)";
  const minutes = delaySeconds / 60;
  if (minutes <= 0) return "hsl(142 55% 36%)";
  if (minutes >= 15) return "hsl(350 58% 24%)";
  const stops = [
    { minute: 0, hue: 142, saturation: 55, lightness: 36 },
    { minute: 3, hue: 52, saturation: 82, lightness: 48 },
    { minute: 8, hue: 28, saturation: 88, lightness: 48 },
    { minute: 15, hue: 0, saturation: 72, lightness: 36 },
  ] as const;
  const upperIndex = stops.findIndex((stop) => stop.minute >= minutes);
  const upper = stops[Math.max(1, upperIndex)]!;
  const lower = stops[Math.max(0, upperIndex - 1)]!;
  const progress = (minutes - lower.minute) / (upper.minute - lower.minute);
  const interpolate = (from: number, to: number) => from + (to - from) * progress;
  return `hsl(${interpolate(lower.hue, upper.hue)} ${interpolate(lower.saturation, upper.saturation)}% ${interpolate(lower.lightness, upper.lightness)}%)`;
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
  const destinationCell = matrix.cells
    .filter((cell) => cell.journeyId === representative.id)
    .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt))
    .at(-1);
  const destination = destinationCell === undefined ? undefined : matrix.stations.find((station) => station.id === destinationCell.stationId);
  return destination === undefined ? (direction === 0 ? messages.common.directionA : messages.common.directionB) : `${messages.live.towards} ${destination.name[lang]}`;
}

export function DailyDelayMatrix({ matrix, lang, messages }: { readonly matrix: MatrixResponse; readonly lang: Lang; readonly messages: Messages }) {
  const directions = useMemo(() => directionIds(matrix), [matrix]);
  const [selectedDirection, setSelectedDirection] = useState<DirectionId>(directions[0] ?? 0);
  const [selected, setSelected] = useState<SelectedCell | null>(null);
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

  return (
    <Ariakit.PopoverProvider open={selected !== null} setOpen={(open) => { if (!open) setSelected(null); }} placement="top">
      <div>
        {directions.length > 1 ? (
          <div aria-label={messages.common.direction} className="mb-3 grid grid-cols-2 gap-2" role="radiogroup" data-testid="live-matrix-directions">
            {directions.map((direction) => (
              <button
                aria-checked={selectedDirection === direction}
                className={`flex min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-bold transition-[background-color,color,transform,opacity] active:scale-[.98] ${selectedDirection === direction ? "bg-muted-soft text-primary" : "text-muted hover:bg-muted-soft"}`}
                key={direction}
                onClick={() => { setSelected(null); setSelectedDirection(direction); }}
                role="radio"
                type="button"
              >
                <ArrowRight aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="truncate">{directionLabel(direction, matrix, lang, messages)}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="overflow-x-auto pb-1" data-testid="live-daily-matrix">
          <div
            className="grid w-max items-center gap-px"
            style={{ gridTemplateColumns: `3.25rem repeat(${stations.length}, .875rem)` }}
          >
            {journeys.flatMap((journey) => {
              const rowCells = stations.map((station) => cells.get(`${journey.id}:${station.id}`));
              const departure = rowCells.find((cell): cell is MatrixCell => cell !== undefined);
              return [
                <span className="pr-1 text-right font-mono text-[10px] font-semibold tabular-nums text-muted" key={`${journey.id}-time`}>
                  {departure === undefined ? "—" : formatMadridTime(departure.scheduledAt, lang)}
                </span>,
                ...stations.map((station, index) => {
                  const cell = rowCells[index];
                  if (cell === undefined) return <span aria-hidden="true" className="size-3.5" key={`${journey.id}-${station.id}`} />;
                  const stationRef = stationById.get(cell.stationId) ?? station;
                  return (
                    <Ariakit.PopoverDisclosure
                      aria-label={`${stationRef.name[lang]}, ${formatMadridTime(cell.scheduledAt, lang)}, ${formatDelay(cell.delaySeconds, lang)}`}
                      className="size-3.5 rounded-[2px] outline-none transition-[transform,box-shadow] hover:scale-125 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--background)]"
                      key={`${journey.id}-${station.id}`}
                      onClick={() => setSelected({ cell, station: stationRef })}
                      style={{ backgroundColor: cellColor(cell.delaySeconds) }}
                    />
                  );
                }),
              ];
            })}
          </div>
        </div>
      </div>

      <Ariakit.Popover
        className="z-[80] min-w-48 rounded-xl border border-border bg-surface-strong p-3 shadow-[var(--shadow-float)] outline-none"
        gutter={7}
        portal
        data-testid="live-matrix-detail"
      >
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
