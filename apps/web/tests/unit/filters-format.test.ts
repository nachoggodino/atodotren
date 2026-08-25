import { describe, expect, it } from "vitest";
import { currentMadridDate, isCalendarDate } from "@/lib/domain/dates";
import { delayBand } from "@/lib/domain/delay-policy";
import { parseHistoryFilters } from "@/lib/domain/filters";
import { formatDelay } from "@/lib/domain/format";

describe("historical URL filters", () => {
  it("parses bounded hour, direction and weekday filters", () => {
    const filters = parseHistoryFilters(new URLSearchParams("from=2026-08-01&to=2026-08-24&hour=8&direction=1&weekdays=1,2,3,4,5"));
    expect(filters).toEqual({ from: "2026-08-01", to: "2026-08-24", hour: 8, direction: 1, weekdays: [1, 2, 3, 4, 5] });
  });

  it("rejects impossible calendar dates and oversized ranges", () => {
    expect(isCalendarDate("2026-99-99")).toBe(false);
    expect(() => parseHistoryFilters(new URLSearchParams("from=2026-99-99&to=2026-08-24"))).toThrow(/Invalid from date/);
    expect(() => parseHistoryFilters(new URLSearchParams("from=2024-01-01&to=2026-08-24"))).toThrow(/exceeds 366 days/);
  });

  it("uses the Madrid calendar day around UTC midnight", () => {
    expect(currentMadridDate(new Date("2026-08-24T22:30:00.000Z"))).toBe("2026-08-25");
    const filters = parseHistoryFilters(new URLSearchParams(), new Date("2026-08-24T22:30:00.000Z"));
    expect(filters.to).toBe("2026-08-25");
    expect(filters.from).toBe("2026-08-12");
  });
});

describe("delay formatting and policy", () => {
  it("keeps internal seconds precise while presenting friendly units", () => {
    expect(formatDelay(186, "es")).toBe("+3 min 06 s");
    expect(delayBand(120)).toBe("punctual");
    expect(delayBand(121)).toBe("mild");
    expect(delayBand(601)).toBe("severe");
  });
});
