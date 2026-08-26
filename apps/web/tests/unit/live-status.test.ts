import { describe, expect, it } from "vitest";
import {
  coverageStatusLevel,
  delayStatusLevel,
  freshnessStatusLevel,
  precisionStatusLevel,
  punctualityStatusLevel,
  sourceStatusLevel,
} from "@/lib/domain/live-status";

describe("live status presentation policy", () => {
  it("uses the requested coverage thresholds", () => {
    expect(coverageStatusLevel(null)).toBe("unknown");
    expect(coverageStatusLevel(0)).toBe("bad");
    expect(coverageStatusLevel(0.33)).toBe("bad");
    expect(coverageStatusLevel(0.331)).toBe("warning");
    expect(coverageStatusLevel(0.659)).toBe("warning");
    expect(coverageStatusLevel(0.66)).toBe("good");
    expect(coverageStatusLevel(1)).toBe("good");
  });

  it("classifies punctuality and delay severity consistently", () => {
    expect(punctualityStatusLevel(null)).toBe("unknown");
    expect(punctualityStatusLevel(0.8)).toBe("good");
    expect(punctualityStatusLevel(0.6)).toBe("warning");
    expect(punctualityStatusLevel(0.599)).toBe("bad");

    expect(delayStatusLevel(null)).toBe("unknown");
    expect(delayStatusLevel(120)).toBe("good");
    expect(delayStatusLevel(121)).toBe("warning");
    expect(delayStatusLevel(300)).toBe("warning");
    expect(delayStatusLevel(301)).toBe("bad");
  });

  it("maps live metadata states to semantic levels", () => {
    expect(sourceStatusLevel("healthy")).toBe("good");
    expect(sourceStatusLevel("stale")).toBe("warning");
    expect(sourceStatusLevel("overnight")).toBe("warning");
    expect(sourceStatusLevel("unavailable")).toBe("bad");

    expect(freshnessStatusLevel("fresh")).toBe("good");
    expect(freshnessStatusLevel("stale")).toBe("bad");
    expect(freshnessStatusLevel("unknown")).toBe("bad");

    expect(precisionStatusLevel("reported")).toBe("good");
    expect(precisionStatusLevel("mixed")).toBe("warning");
    expect(precisionStatusLevel("schematic-inferred")).toBe("bad");
  });
});
