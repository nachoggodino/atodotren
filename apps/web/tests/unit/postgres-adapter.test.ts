import { describe, expect, it } from "vitest";
import type { WebServerConfig } from "@/lib/server/config";
import { createPostgresAdapter } from "@/lib/server/postgres-adapter";
import type { PostgresClient, RawPostgresRow } from "@/lib/server/postgres/client";
import { parseJourneyRow } from "@/lib/server/postgres/row-parser";
import { medianFromHistogram, normalizeHistogram } from "@/lib/server/postgres/stats";

const config: WebServerConfig = {
  mode: "postgres",
  fixtureScenario: "healthy",
  fixtureScenarioOverridesEnabled: false,
  databaseUrl: "postgres://example.invalid/atodotren",
  databaseSslMode: "verify-full",
  databaseSslCa: null,
  poolMax: 1,
  statementTimeoutMs: 5_000,
};

function histogram(index: number, count = 1): number[] {
  const values = Array.from({ length: 72 }, () => 0);
  values[index] = count;
  return values;
}

function aggregateRow(serviceDate = "2026-08-20"): RawPostgresRow {
  return {
    service_date: serviceDate,
    scheduled_opportunities: 10,
    valid_delay_observations: 9,
    punctual_count: 8,
    signed_delay_sum: 90,
    canceled_count: 0,
    missing_evidence_count: 1,
    delay_histogram: histogram(15, 9),
    aggregate_algorithm_version: "v1",
    aggregate_algorithm_version_max: "v1",
  };
}

function client(query: PostgresClient["query"]): PostgresClient {
  return { query, close: async () => undefined };
}

describe("PostgreSQL domain mapping", () => {
  it("normalizes the 72-bin h30-v1 histogram before React sees it", () => {
    const values = histogram(0, 2);
    values[1] = 3;
    values[15] = 4;
    values[71] = 5;
    expect(medianFromHistogram(values)).toBe(1815);
    const normalized = normalizeHistogram(values);
    expect(normalized).toHaveLength(6);
    expect(normalized.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(14);
    expect(normalized.find((bucket) => bucket.id === "delay-15-plus")?.count).toBe(5);
  });

  it("rejects unknown evidence enum values instead of casting them", () => {
    expect(() => parseJourneyRow({
      service_date: "2026-08-20", journey_id: 1, source_trip_id: "trip", line_slug: "c1", public_code: "C1", direction: 0,
      station_id: "atocha", station_name_es: "Atocha", station_name_en: "Atocha", scheduled_arrival_at: "2026-08-20T08:00:00Z",
      renfe_arrival_at: null, selected_delay_seconds: null, first_stopped_presence_at: null, evidence_status: "invented",
      evidence_selected_captured_at: null, canonical_algorithm_version: "v1",
    })).toThrow(/invalid evidence_status/);
  });

  it("applies weekday, hour and direction in SQL and does not use a silent history LIMIT", async () => {
    const calls: string[] = [];
    const adapter = createPostgresAdapter(config, client(async (text) => {
      calls.push(text);
      if (text.includes("GROUP BY history.line_slug")) return [{ line_slug: "c1", public_code: "C1", valid_delay_observations: 100, punctual_count: 80, signed_delay_sum: 12000 }];
      if (text.includes("WITH filtered") && text.includes("api.history_network_hour")) return [aggregateRow()];
      if (text.includes("api.service_day_state")) return [{ service_date: "2026-08-20", aggregate_algorithm_version: "v1", status: "verified", finalized_at: "2026-08-21T02:00:00Z" }];
      throw new Error(`Unexpected query: ${text}`);
    }));
    const result = await adapter.historyNetwork({ from: "2026-08-20", to: "2026-08-20", weekdays: [4], hour: 8, direction: 1 });
    const aggregateSql = calls.find((text) => text.includes("WITH filtered")) ?? "";
    expect(aggregateSql).toContain("extract(dow FROM service_date)");
    expect(aggregateSql).toContain("scheduled_hour");
    expect(aggregateSql).toContain("direction");
    expect(aggregateSql).not.toMatch(/LIMIT\s+\d+/i);
    expect(result.rankings.status).toBe("available");
    expect(result.meta.finalization.state).toBe("finalized");
  });

  it("detects the matrix public-contract hard bound instead of treating 6000 rows as complete", async () => {
    const adapter = createPostgresAdapter(config, client(async (text) => {
      if (text.includes("api.line_catalog")) return [{ slug: "c1", public_code: "C1", name_es: "C1", name_en: "C1", color: "5aa1d8" }];
      if (text.includes("api.recent_line_matrix")) return Array.from({ length: 6000 }, () => ({}));
      throw new Error(`Unexpected query: ${text}`);
    }));
    await expect(adapter.matrix("c1", "2026-08-24")).resolves.toEqual({ status: "failed", reason: "result-too-large" });
  });
});
