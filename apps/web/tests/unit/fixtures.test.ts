import { describe, expect, it } from "vitest";
import { createFixtureAdapter } from "@/lib/fixtures/scenarios";

 describe("fixture contract scenarios", () => {
  it("covers healthy, partial, stale, outage and overnight live metadata", async () => {
    const healthy = await createFixtureAdapter("healthy").liveNetwork();
    const partial = await createFixtureAdapter("partial").liveNetwork();
    const stale = await createFixtureAdapter("stale").liveNetwork();
    const outage = await createFixtureAdapter("outage").liveNetwork();
    const overnight = await createFixtureAdapter("overnight").liveNetwork();
    expect(healthy.meta.status).toBe("live");
    expect(partial.meta.coverage.ratio).toBeLessThan(healthy.meta.coverage.ratio ?? 1);
    expect(stale.meta.status).toBe("stale");
    expect(outage.meta.status).toBe("outage");
    expect(overnight.meta.status).toBe("overnight");
    expect(overnight.lines.every((line) => line.activeTrains === 0)).toBe(true);
  });

  it("keeps inferred positions explicit and never calls them GPS", async () => {
    const line = await createFixtureAdapter("healthy").liveLine("c1");
    const inferred = line?.trains.find((train) => train.position.kind === "between_stations");
    expect(inferred?.position.basis).toBe("feed-inferred");
    expect(inferred?.position.confidence).not.toBe("high");
  });

  it("supports cancellation, missing, incomplete/finalized and offline states", async () => {
    const canceled = await createFixtureAdapter("cancellations").matrix("c1", "2026-08-24");
    const missing = await createFixtureAdapter("missing").matrix("c1", "2026-08-24");
    const finalized = await createFixtureAdapter("finalized").historyNetwork({ from: "2026-08-20", to: "2026-08-24", weekdays: [], hour: null, direction: null });
    const offline = await createFixtureAdapter("offline-cached").liveNetwork();
    expect(canceled?.cells.some((cell) => cell.state === "canceled")).toBe(true);
    expect(missing?.cells.some((cell) => cell.state === "missing_evidence")).toBe(true);
    expect(finalized.meta.finalized).toBe(true);
    expect(offline.meta.cache).toBe("offline");
  });

  it("handles ambiguous and empty search without guessing", async () => {
    const ambiguous = await createFixtureAdapter("ambiguous-search").search("aeropuerto");
    const empty = await createFixtureAdapter("empty-search").search("atocha");
    expect(ambiguous.filter((result) => result.kind === "station").length).toBeGreaterThan(1);
    expect(empty).toEqual([]);
  });
});
