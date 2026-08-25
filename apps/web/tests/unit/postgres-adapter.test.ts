import { beforeEach, describe, expect, it, vi } from "vitest";
import { SEARCH_RESULT_LIMIT } from "@/lib/domain/search";
import type { WebServerConfig } from "@/lib/server/config";

const mocks = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn() }));

vi.mock("pg", () => ({
  Pool: class {
    query = mocks.query;
    end = mocks.end;
  },
}));

import { createPostgresAdapter } from "@/lib/server/postgres-adapter";

const config: WebServerConfig = {
  mode: "postgres",
  fixtureScenario: "healthy",
  databaseUrl: "postgres://example.invalid/atodotren",
  databaseSslMode: "disable",
  poolMax: 1,
  statementTimeoutMs: 5_000,
};

describe("PostgreSQL public-data adapter", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.end.mockReset();
  });

  it("filters live station vehicles in PostgreSQL before applying the station limit", async () => {
    mocks.query.mockImplementation(async (text: string, values: unknown[] = []) => {
      if (text.includes("api.station_catalog")) return { rows: [{ station_id: "atocha", slug_es: "atocha", slug_en: "atocha", name_es: "Atocha", name_en: "Atocha" }] };
      if (text.includes("api.history_station_hour")) return { rows: [] };
      if (text.includes("api.live_health")) return { rows: [{ latest_successful_poll_at: "2026-08-25T07:00:00.000Z" }] };
      if (text.includes("api.live_vehicle")) {
        expect(text).toContain("current_station_id = $1");
        expect(text).toContain("LIMIT 60");
        expect(values).toEqual(["atocha"]);
        return { rows: [{ current_station_id: "atocha", line_slug: "c1", public_code: "C1", line_name_es: "C1", line_name_en: "C1", color: "5aa1d8", vehicle_id: "C1-1", journey_id: "101", service_date: "2026-08-25", latest_stop_delay: 30, vehicle_timestamp: "2026-08-25T07:00:00.000Z", captured_at: "2026-08-25T07:00:00.000Z" }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    const result = await createPostgresAdapter(config).liveStation("atocha");
    expect(result?.trains).toHaveLength(1);
  });

  it("constructs historical metadata correctly without a downstream outage repair", async () => {
    mocks.query.mockImplementation(async (text: string) => {
      if (text.includes("FROM api.history_network_day") && text.includes("service_date BETWEEN")) {
        return { rows: [{ service_date: "2026-08-20", scheduled_opportunities: 10, valid_delay_observations: 9, punctual_count: 8, signed_delay_sum: 90, delay_histogram: [0, 9], canceled_count: 0, missing_evidence_count: 1, aggregate_algorithm_version: "v1" }] };
      }
      if (text.includes("FROM api.history_line_day")) return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });

    const filters = { from: "2026-08-20", to: "2026-08-20", weekdays: [], hour: null, direction: null } as const;
    const result = await createPostgresAdapter(config).historyNetwork(filters);
    expect(result.meta).toMatchObject({ sourceAt: null, status: "live", stale: false, serviceDate: filters.to });
  });

  it("uses shared search and matrix query limits instead of duplicated literals at call sites", async () => {
    mocks.query.mockImplementation(async (text: string) => {
      if (text.includes("api.catalog_search")) return { rows: [] };
      if (text.includes("api.line_catalog")) return { rows: [{ line_slug: "c1", slug: "c1", public_code: "C1", name_es: "C1", name_en: "C1", color: "5aa1d8" }] };
      if (text.includes("api.recent_line_matrix")) return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });

    const adapter = createPostgresAdapter(config);
    await adapter.search("atocha");
    await adapter.matrix("c1", "2026-08-24");

    const searchCall = mocks.query.mock.calls.find(([text]) => String(text).includes("api.catalog_search"));
    expect(searchCall?.[1]).toEqual(["atocha", SEARCH_RESULT_LIMIT]);
    const matrixCall = mocks.query.mock.calls.find(([text]) => String(text).includes("api.recent_line_matrix"));
    expect(matrixCall?.[1]).toEqual(["c1", "2026-08-24", 6_000]);
  });
});
