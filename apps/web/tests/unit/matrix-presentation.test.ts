import { describe, expect, it } from "vitest";
import type { EvidenceState } from "@/lib/domain/contracts";
import { matrixCellPresentation } from "@/lib/domain/matrix-presentation";

function present(state: EvidenceState, delaySeconds: number | null) {
  return matrixCellPresentation({ state, delaySeconds });
}

describe("matrix cell presentation", () => {
  it("gives lifecycle evidence states precedence over numeric delay", () => {
    expect(present("canceled", 30)).toEqual({ kind: "canceled", symbol: "×" });
    expect(present("skipped", 30)).toEqual({ kind: "skipped", symbol: "↷" });
    expect(present("missing_evidence", 30)).toEqual({ kind: "missing", symbol: "—" });
    expect(present("pending", 30)).toEqual({ kind: "pending", symbol: "…" });
  });

  it("uses one shared delay policy for live and historical matrices", () => {
    expect(present("reported_only", null)).toEqual({ kind: "missing", symbol: "—" });
    expect(present("observed_presence", -1)).toEqual({ kind: "early", symbol: "−" });
    expect(present("reported_only", 120)).toEqual({ kind: "punctual", symbol: "✓" });
    expect(present("reported_only", 121)).toEqual({ kind: "mild", symbol: "+" });
    expect(present("reported_only", 301)).toEqual({ kind: "delayed", symbol: "+" });
    expect(present("reported_only", 601)).toEqual({ kind: "severe", symbol: "!!" });
  });
});
