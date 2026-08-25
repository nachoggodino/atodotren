import { afterEach, describe, expect, it, vi } from "vitest";
import { currentMadridDate } from "@/lib/domain/dates";
import { getCached } from "@/lib/server/cache";
import { cacheSecondsForDate, cacheSecondsForHistory } from "@/lib/server/history-request";

describe("server cache and Madrid history policy", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces concurrent cache misses for the same key", async () => {
    let loads = 0;
    let resolve!: (value: number) => void;
    const loader = vi.fn(async () => { loads += 1; return new Promise<number>((done) => { resolve = done; }); });
    const first = getCached("single-flight:test", 30, loader);
    const second = getCached("single-flight:test", 30, loader);
    expect(loads).toBe(1);
    resolve(42);
    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("does not poison the cache after a failed loader", async () => {
    let attempts = 0;
    const loader = async () => { attempts += 1; if (attempts === 1) throw new Error("boom"); return 7; };
    await expect(getCached("single-flight:failure", 30, loader)).rejects.toThrow("boom");
    await expect(getCached("single-flight:failure", 30, loader)).resolves.toBe(7);
    expect(attempts).toBe(2);
  });

  it("reloads expired entries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T07:00:00.000Z"));
    let loads = 0;
    const load = async () => { loads += 1; return loads; };
    expect(await getCached("expiry:test", 1, load)).toBe(1);
    expect(await getCached("expiry:test", 1, load)).toBe(1);
    vi.advanceTimersByTime(1_001);
    expect(await getCached("expiry:test", 1, load)).toBe(2);
  });

  it("uses Europe/Madrid for service-date defaults and history TTLs", () => {
    const now = new Date("2026-08-24T22:30:00.000Z");
    expect(currentMadridDate(now)).toBe("2026-08-25");
    expect(cacheSecondsForDate("2026-08-24", now)).toBe(3_600);
    expect(cacheSecondsForDate("2026-08-25", now)).toBe(300);
    expect(cacheSecondsForHistory({ from: "2026-08-20", to: "2026-08-24", weekdays: [], hour: null, direction: null }, now)).toBe(3_600);
  });
});
