import { describe, expect, it } from "vitest";
import { createFixtureAdapter } from "@/lib/fixtures/scenarios";

const baseFilters = { from: "2026-08-18", to: "2026-08-24", weekdays: [], hour: null, direction: null } as const;

describe("fixture scenarios", () => {
  it("provides the source states required by browser acceptance tests", async () => {
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
  });

  it("makes history filters materially change fixture results", async () => {
    const adapter = createFixtureAdapter("healthy");
    const baseline = await adapter.historyNetwork(baseFilters);
    const hour = await adapter.historyNetwork({ ...baseFilters, hour: 8 });
    const hourRange = await adapter.historyNetwork({ ...baseFilters, hour: 6, hourTo: 7 });
    const direction = await adapter.historyNetwork({ ...baseFilters, direction: 1 });
    const weekdays = await adapter.historyNetwork({ ...baseFilters, weekdays: [1] });
    expect(hour.stats.meanDelaySeconds).not.toBe(baseline.stats.meanDelaySeconds);
    expect(hourRange.stats.meanDelaySeconds).not.toBe(hour.stats.meanDelaySeconds);
    expect(direction.stats.scheduled).not.toBe(baseline.stats.scheduled);
    expect(weekdays.trend.length).toBeLessThan(baseline.trend.length);
  });

  it("keeps fixture-only capability states explicit", async () => {
    const unsupported = await createFixtureAdapter("unsupported-capabilities").historyLine("c1", baseFilters);
    const mixed = await createFixtureAdapter("mixed-versions").historyNetwork(baseFilters);
    const expired = await createFixtureAdapter("healthy").matrix("c1", "2026-07-01");
    expect(unsupported?.rankings).toEqual({ status: "unavailable", reason: "not-supported" });
    expect(mixed.meta.provenance.kind).toBe("mixed");
    expect(expired).toEqual({ status: "unavailable", reason: "retention" });
  });
});