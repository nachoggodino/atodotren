import { describe, expect, it } from "vitest";
import { createFixtureAdapter } from "@/lib/fixtures/scenarios";

const baseFilters = { from: "2026-08-18", to: "2026-08-24", weekdays: [], hour: null, direction: null } as const;

describe("fixture contract scenarios", () => {
  it("models source/freshness states without overloading client refresh state", async () => {
    const healthy = await createFixtureAdapter("healthy").liveNetwork();
    const partial = await createFixtureAdapter("partial").liveNetwork();
    const stale = await createFixtureAdapter("stale").liveNetwork();
    const outage = await createFixtureAdapter("outage").liveNetwork();
    const overnight = await createFixtureAdapter("overnight").liveNetwork();
    expect(healthy.meta.source.status).toBe("healthy");
    expect(partial.meta.coverage.ratio).toBeLessThan(healthy.meta.coverage.ratio ?? 1);
    expect(stale.meta.source.status).toBe("stale");
    expect(outage.meta.source.status).toBe("unavailable");
    expect(overnight.meta.source.status).toBe("overnight");
    expect(overnight.lines.every((line) => line.activeTrains === 0)).toBe(true);
  });

  it("covers reverse, branch and unknown train positions", async () => {
    const line = await createFixtureAdapter("reverse-branch").liveLine("c1");
    expect(line?.patterns.length).toBeGreaterThan(2);
    expect(line?.trains.some((train) => train.direction?.id === 1 && train.position.kind === "between_stations")).toBe(true);
    expect(line?.trains.some((train) => train.patternId === null && train.position.kind === "unknown")).toBe(true);
  });

  it("makes hour, direction and weekday filters materially change historical results", async () => {
    const adapter = createFixtureAdapter("healthy");
    const baseline = await adapter.historyNetwork(baseFilters);
    const hour = await adapter.historyNetwork({ ...baseFilters, hour: 8 });
    const direction = await adapter.historyNetwork({ ...baseFilters, direction: 1 });
    const weekdays = await adapter.historyNetwork({ ...baseFilters, weekdays: [1] });
    expect(hour.stats.meanDelaySeconds).not.toBe(baseline.stats.meanDelaySeconds);
    expect(direction.stats.scheduled).not.toBe(baseline.stats.scheduled);
    expect(weekdays.trend.length).toBeLessThan(baseline.trend.length);
  });

  it("keeps a full 365-day history without fixture-side truncation", async () => {
    const filters = { from: "2025-08-25", to: "2026-08-24", weekdays: [], hour: null, direction: null } as const;
    const history = await createFixtureAdapter("large-history").historyNetwork(filters);
    expect(history.filters).toEqual(filters);
    expect(history.trend).toHaveLength(365);
    expect(history.trend[0]?.date).toBe(filters.from);
    expect(history.trend.at(-1)?.date).toBe(filters.to);
    expect(new Set(history.trend.map((point) => point.date))).toHaveLength(365);
  });

  it("represents unsupported capabilities and mixed provenance explicitly", async () => {
    const unsupported = await createFixtureAdapter("unsupported-capabilities").historyLine("c1", baseFilters);
    const mixed = await createFixtureAdapter("mixed-versions").historyNetwork(baseFilters);
    expect(unsupported?.rankings).toEqual({ status: "unavailable", reason: "not-supported" });
    expect(mixed.meta.provenance.kind).toBe("mixed");
  });

  it("models matrix retention and available data separately", async () => {
    const available = await createFixtureAdapter("cancellations").matrix("c1", "2026-08-24");
    const expired = await createFixtureAdapter("healthy").matrix("c1", "2026-07-01");
    expect(available.status).toBe("available");
    if (available.status === "available") expect(available.matrix.cells.some((cell) => cell.state === "canceled")).toBe(true);
    expect(expired).toEqual({ status: "unavailable", reason: "retention" });
  });
});
