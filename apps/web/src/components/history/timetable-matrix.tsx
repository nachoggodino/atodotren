"use client";

import { X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Lang, MatrixCell, MatrixResponse } from "@/lib/domain/contracts";
import { DELAY_SEVERITY_THRESHOLDS_SECONDS, delayBand } from "@/lib/domain/delay-policy";
import { formatDelay, formatMadridTime } from "@/lib/domain/format";
import { evidenceLabel } from "@/lib/i18n/domain-labels";
import type { Messages } from "@/messages/types";

function symbol(cell: MatrixCell): string {
  if (cell.state === "canceled") return "×";
  if (cell.state === "skipped") return "↷";
  if (cell.state === "missing_evidence") return "—";
  if (cell.state === "pending") return "…";
  switch (delayBand(cell.delaySeconds)) {
    case "punctual":
      return "✓";
    case "mild":
    case "delayed":
      return "+";
    case "severe":
      return "!!";
    case "unknown":
      return "?";
  }
}

const PUNCTUAL_MINUTES = DELAY_SEVERITY_THRESHOLDS_SECONDS.punctual / 60;
const SEVERE_MINUTES = DELAY_SEVERITY_THRESHOLDS_SECONDS.delayed / 60;

export function TimetableMatrix({ matrix, lang, messages }: { readonly matrix: MatrixResponse; readonly lang: Lang; readonly messages: Messages }) {
  const [selected, setSelected] = useState<MatrixCell | null>(null);
  const cells = useMemo(
    () => new Map(matrix.cells.map((cell) => [`${cell.stationId}:${cell.journeyId}`, cell])),
    [matrix.cells],
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted" aria-label={messages.history.legend}>
        <span>✓ ≤{PUNCTUAL_MINUTES}m</span>
        <span>+ {PUNCTUAL_MINUTES}–{SEVERE_MINUTES}m</span>
        <span>!! &gt;{SEVERE_MINUTES}m</span>
        <span>× {messages.history.canceled}</span>
        <span>↷ {messages.history.skipped}</span>
        <span>— {messages.common.missing.toLowerCase()}</span>
        <span>… {messages.history.pending}</span>
      </div>
      <div className="max-h-[70vh] overflow-auto rounded-xl border border-border" data-testid="timetable-matrix">
        <table className="min-w-max border-collapse text-xs">
          <thead className="sticky top-0 z-20 bg-surface-strong">
            <tr>
              <th className="sticky left-0 z-30 min-w-44 border-b border-r border-border bg-surface-strong p-3 text-left">{messages.history.stationColumn}</th>
              {matrix.journeys.map((journey) => (
                <th className="min-w-24 border-b border-border p-2 text-center font-bold" key={journey.id}>{journey.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.stations.map((station) => (
              <tr key={station.id}>
                <th className="sticky left-0 z-10 max-w-64 border-r border-t border-border bg-surface-strong p-3 text-left font-bold whitespace-normal">{station.name[lang]}</th>
                {matrix.journeys.map((journey) => {
                  const cell = cells.get(`${station.id}:${journey.id}`);
                  if (cell === undefined) return <td className="border-t border-border p-2 text-center text-muted" key={journey.id}>·</td>;
                  return (
                    <td className="border-t border-border p-0" key={journey.id}>
                      <button
                        className="delay-cell grid min-h-14 w-full place-items-center gap-0.5 px-2 py-1 text-center hover:ring-2 hover:ring-inset hover:ring-primary"
                        data-band={delayBand(cell.delaySeconds)}
                        data-state={cell.state}
                        onClick={() => setSelected(cell)}
                        type="button"
                      >
                        <strong className="font-mono text-[11px]">{formatMadridTime(cell.scheduledAt, lang)}</strong>
                        <span aria-hidden="true" className="font-black">{symbol(cell)}</span>
                        <span className="sr-only">{evidenceLabel(cell.state, messages)}, {formatDelay(cell.delaySeconds, lang)}</span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected ? (
        <div className="mt-3 flex items-start justify-between gap-4 rounded-lg border border-border bg-surface-strong p-4" data-testid="matrix-detail">
          <div>
            <p className="eyebrow">{messages.common.details}</p>
            <p className="mt-1 font-bold">{formatMadridTime(selected.scheduledAt, lang)} · {evidenceLabel(selected.state, messages)}</p>
            <p className="mt-1 text-sm text-muted">{formatDelay(selected.delaySeconds, lang)}</p>
          </div>
          <button className="grid size-10 place-items-center rounded-md hover:bg-muted-soft" onClick={() => setSelected(null)} aria-label={messages.nav.close} type="button">
            <X className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
