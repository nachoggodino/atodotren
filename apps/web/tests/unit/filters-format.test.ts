import { describe, expect, it } from "vitest";
import { boundedDateRange, parseHistoryFilters } from "@/lib/domain/filters";
import { delayBand, evidenceLabel, formatDelay } from "@/lib/domain/format";

 describe("historical URL filters", () => {
  it("parses bounded hour, direction and weekday filters", () => {
    const filters = parseHistoryFilters(new URLSearchParams("from=2026-08-01&to=2026-08-24&hour=8&direction=1&weekdays=1,2,3,4,5"));
    expect(filters).toEqual({ from: "2026-08-01", to: "2026-08-24", hour: 8, direction: 1, weekdays: [1, 2, 3, 4, 5] });
    expect(boundedDateRange(filters)).toEqual(filters);
  });

  it("rejects oversized historical ranges", () => {
    const filters = parseHistoryFilters(new URLSearchParams("from=2024-01-01&to=2026-08-24"));
    expect(() => boundedDateRange(filters)).toThrow(/exceeds 366 days/);
  });
});

describe("delay and evidence formatting", () => {
  it("keeps internal seconds precise while presenting friendly units", () => {
    expect(formatDelay(186, "es")).toBe("+3 min 06 s");
    expect(delayBand(120)).toBe("punctual");
    expect(delayBand(121)).toBe("mild");
    expect(delayBand(601)).toBe("severe");
  });

  it("localizes non-delay evidence states", () => {
    expect(evidenceLabel("missing_evidence", "es")).toBe("Sin evidencia");
    expect(evidenceLabel("missing_evidence", "en")).toBe("Missing evidence");
  });
});
