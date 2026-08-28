import type { MatrixCell } from "./contracts";
import { delayBand } from "./delay-policy";

export type MatrixCellKind = "early" | "punctual" | "mild" | "delayed" | "severe" | "canceled" | "skipped" | "missing" | "pending";

export interface MatrixCellPresentation {
  readonly kind: MatrixCellKind;
  readonly symbol: string;
}

export function matrixCellPresentation(cell: Pick<MatrixCell, "state" | "delaySeconds">): MatrixCellPresentation {
  switch (cell.state) {
    case "canceled":
      return { kind: "canceled", symbol: "×" };
    case "skipped":
      return { kind: "skipped", symbol: "↷" };
    case "missing_evidence":
      return { kind: "missing", symbol: "—" };
    case "pending":
      return { kind: "pending", symbol: "…" };
    case "reported_only":
    case "observed_presence":
      break;
  }
  if (cell.delaySeconds === null) return { kind: "missing", symbol: "—" };
  if (cell.delaySeconds < 0) return { kind: "early", symbol: "−" };
  switch (delayBand(cell.delaySeconds)) {
    case "punctual":
      return { kind: "punctual", symbol: "✓" };
    case "mild":
      return { kind: "mild", symbol: "+" };
    case "delayed":
      return { kind: "delayed", symbol: "+" };
    case "severe":
      return { kind: "severe", symbol: "!!" };
    case "unknown":
      return { kind: "missing", symbol: "—" };
  }
}
