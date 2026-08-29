import { describe, expect, it } from "vitest";
import { createLiveRepository } from "@/lib/server/postgres/live-repository";
import type { CatalogRepository } from "@/lib/server/postgres/catalog-repository";
import type { PostgresClient } from "@/lib/server/postgres/client";
import type { MetadataRepository } from "@/lib/server/postgres/metadata-repository";
import type { TopologyRepository } from "@/lib/server/postgres/topology-repository";

const catalog: CatalogRepository = {
  async lines() { return []; },
  async line() { return null; },
  async station() {
    return { id: "atocha", slug: { es: "atocha", en: "atocha" }, name: { es: "Atocha", en: "Atocha" } };
  },
  async search() { return []; },
};

const metadata: MetadataRepository = {
  async forDates() {
    return { finalization: { state: "processing", finalizedAt: null }, provenance: { kind: "none" } };
  },
};

const topology: TopologyRepository = {
  async patterns() { return []; },
  async directions() { return []; },
};

describe("live station repository", () => {
  it("preserves a negative signed station-added delay total", async () => {
    const client: PostgresClient = {
      async query(text) {
        if (text.includes("api.station_live_day_metrics")) return [{ total_added_delay_seconds: -95, usable_stop_count: 4 }];
        return [];
      },
      async close() {},
    };

    const repository = createLiveRepository(client, catalog, metadata, topology);
    const station = await repository.station("atocha", new Date("2026-08-29T10:00:00Z"));

    expect(station?.stationInsights.totalAddedDelaySeconds).toBe(-95);
  });
});
