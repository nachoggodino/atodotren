import { afterEach, describe, expect, it, vi } from "vitest";
import { withTtlCache } from "@/lib/server/cache";
import { cacheSecondsForDate, cacheSecondsForHistory, madridDate } from "@/lib/server/history-request";

describe("server cache and Madrid history policy", () => {
  afterEach(() => vi.useRealTimers());

  it("evicts the oldest valid entry when the per-instance cache reaches its hard bound", async () => {
    for (let index = 0; index <= 250; index += 1) {
      await withTtlCache(`bound:${index}`, 3_600, async () => index);
    }
    let reloads = 0;
    const value = await withTtlCache("bound:0", 3_600, async () => { reloads += 1; return 999; });
    expect(value).toBe(999);
    expect(reloads).toBe(1);
  });

  it("reloads expired entries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T07:00:00.000Z"));
    let loads = 0;
    const load = async () => { loads += 1; return loads; };
    expect(await withTtlCache("expiry:test", 1, load)).toBe(1);
    expect(await withTtlCache("expiry:test", 1, load)).toBe(1);
    vi.advanceTimersByTime(1_001);
    expect(await withTtlCache("expiry:test", 1, load)).toBe(2);
  });

  it("uses one Madrid date and history TTL policy across server callers", () => {
    const now = new Date("2026-08-24T22:30:00.000Z");
    expect(madridDate(now)).toBe("2026-08-25");
    expect(cacheSecondsForDate("2026-08-24", now)).toBe(3_600);
    expect(cacheSecondsForDate("2026-08-25", now)).toBe(300);
    expect(cacheSecondsForHistory({ from: "2026-08-20", to: "2026-08-24", weekdays: [], hour: null, direction: null }, now)).toBe(3_600);
  });
});
