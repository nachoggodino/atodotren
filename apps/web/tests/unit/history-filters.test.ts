import { describe, expect, it } from "vitest";
import { currentMadridDate, isCalendarDate } from "@/lib/domain/dates";
import { parseHistoryFilters } from "@/lib/domain/filters";

describe("historical URL filters", () => {
  it("parses bounded hour, direction and weekday filters", () => {
    const filters = parseHistoryFilters(new URLSearchParams("from=2026-08-01&to=2026-08-24&hour=8&direction=1&weekdays=1,2,3,4,5"));
    expect(filters).toEqual({ from: "2026-08-01", to: "2026-08-24", hour: 8, direction: 1, weekdays: [1, 2, 3, 4, 5] });
  });

  it("rejects impossible dates and oversized ranges", () => {
    expect(isCalendarDate("2026-99-99")).toBe(false);
    expect(() => parseHistoryFilters(new URLSearchParams("from=2026-99-99&to=2026-08-24"))).toThrow(/Invalid from date/);
    expect(() => parseHistoryFilters(new URLSearchParams("from=2024-01-01&to=2026-08-24"))).toThrow(/exceeds 366 days/);
  });

  it("uses the Madrid calendar day for default ranges around UTC midnight", () => {
    const now = new Date("2026-08-24T22:30:00.000Z");
    expect(currentMadridDate(now)).toBe("2026-08-25");
    const filters = parseHistoryFilters(new URLSearchParams(), now);
    expect(filters.to).toBe("2026-08-25");
    expect(filters.from).toBe("2026-08-12");
  });
});
