import { describe, expect, it } from "vitest";
import { liveResponseMeta } from "@/lib/domain/data-policy";
import { emptySummaryStats } from "@/lib/server/postgres/stats";

const NOW = new Date("2026-08-25T10:00:00.000Z");
const SOURCE_AT = "2026-08-25T09:59:30.000Z";

function meta(expectedOvernight?: boolean) {
  return liveResponseMeta({
    stats: emptySummaryStats(),
    sourceAt: SOURCE_AT,
    activeTrains: 0,
    serviceDate: "2026-08-25",
    finalization: { state: "processing", finalizedAt: null },
    provenance: { kind: "none" },
    ...(expectedOvernight === undefined ? {} : { expectedOvernight }),
    now: NOW,
  });
}

describe("live source policy", () => {
  it("does not infer overnight solely from a fresh empty vehicle snapshot", () => {
    const result = meta();
    expect(result.source.status).toBe("unavailable");
    expect(result.source.freshness.state).toBe("fresh");
  });

  it("uses overnight only when the provider can state that condition explicitly", () => {
    expect(meta(true).source.status).toBe("overnight");
  });
});
