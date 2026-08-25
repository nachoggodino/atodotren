import { describe, expect, it } from "vitest";
import type { PublicDataAdapter } from "@/lib/server/data-adapter";
import { createFixtureAdapter } from "@/lib/fixtures/scenarios";
import { currentMadridDate } from "@/lib/domain/dates";
import type { HistoryFilters } from "@/lib/domain/contracts";
import type { WebServerConfig } from "@/lib/server/config";
import { createPostgresAdapter } from "@/lib/server/postgres-adapter";
import type { PostgresClient, RawPostgresRow } from "@/lib/server/postgres/client";

const EXPECTED_BUCKETS = ["early", "punctual", "delay-2-5", "delay-5-10", "delay-10-15", "delay-15-plus"] as const;
type ContractScenario = "healthy" | "stale" | "outage" | "mixed";

interface AdapterHarness {
  readonly date: string;
  create(scenario: ContractScenario): PublicDataAdapter;
}

function contractFilters(date: string): HistoryFilters {
  return { from: date, to: date, weekdays: [], hour: 8, direction: 1 };
}

function expectNormalizedDistribution(values: readonly { readonly id: string; readonly count: number }[]) {
  expect(values.map((item) => item.id)).toEqual(EXPECTED_BUCKETS);
  expect(values.every((item) => Number.isInteger(item.count) && item.count >= 0)).toBe(true);
}

function publicDataAdapterContract(name: string, harness: AdapterHarness) {
  describe(`${name} PublicDataAdapter contract`, () => {
    it("searches canonical entities without leaking provider shapes", async () => {
      const results = await harness.create("healthy").search("Atocha");
      const station = results.find((result) => result.kind === "station");
      expect(station).toBeDefined();
      expect(station?.slug.es).toBeTruthy();
      expect(station?.slug.en).toBeTruthy();
      expect(station).not.toHaveProperty("station_slug_es");
    });

    it("exposes live line statistics as data or an explicit capability", async () => {
      const data = await harness.create("healthy").liveNetwork();
      expect(data.lines.length).toBeGreaterThan(0);
      expectNormalizedDistribution(data.stats.distribution);
      for (const line of data.lines) {
        expect(["available", "insufficient-sample", "unavailable"]).toContain(line.stats.status);
        if (line.stats.status === "available") expectNormalizedDistribution(line.stats.value.distribution);
      }
    });

    it("keeps comparisons, topology, directions and position evidence semantic", async () => {
      const adapter = harness.create("healthy");
      const line = await adapter.liveLine("c1");
      const station = await adapter.liveStation("atocha");
      expect(line).not.toBeNull();
      expect(station).not.toBeNull();
      expect(["available", "insufficient-sample", "unavailable"]).toContain(line?.comparison.status);
      expect(["available", "insufficient-sample", "unavailable"]).toContain(station?.comparison.status);
      expect(new Set(line?.patterns.map((pattern) => pattern.direction.id))).toEqual(new Set([0, 1]));
      expect(line?.trains.some((train) => train.position.kind === "unknown")).toBe(true);
      expect(line?.trains.every((train) => ["reported_only", "observed_presence", "skipped", "canceled", "missing_evidence", "pending"].includes(train.state))).toBe(true);
      expect(line?.trains.every((train) => train.position.basis !== "unavailable" || train.position.kind === "unknown")).toBe(true);
    });

    it("keeps history filters, rankings, finalization and normalized distributions aligned", async () => {
      const adapter = harness.create("healthy");
      const filters = contractFilters(harness.date);
      const network = await adapter.historyNetwork(filters);
      const line = await adapter.historyLine("c1", filters);
      const station = await adapter.historyStation("atocha", filters);
      expect(network.filters).toEqual(filters);
      expect(network.rankings.status).toBe("available");
      expect(line?.rankings).toEqual({ status: "unavailable", reason: "not-supported" });
      expect(station?.rankings).toEqual({ status: "unavailable", reason: "not-supported" });
      expect(["finalized", "processing", "unknown"]).toContain(network.meta.finalization.state);
      expectNormalizedDistribution(network.stats.distribution);
      expect(network.trend.every((point) => point.date >= filters.from && point.date <= filters.to)).toBe(true);
    });

    it("represents matrix availability explicitly", async () => {
      const result = await harness.create("healthy").matrix("c1", harness.date);
      expect(result.status).toBe("available");
      if (result.status === "available") {
        expect(result.matrix.cells.length).toBeGreaterThan(0);
        expect(result.matrix.cells.every((cell) => typeof cell.state === "string")).toBe(true);
      }
    });

    it("uses the same stale and outage semantics", async () => {
      const stale = await harness.create("stale").liveNetwork();
      const outage = await harness.create("outage").liveNetwork();
      expect(stale.meta.source.status).toBe("stale");
      expect(stale.meta.source.freshness.state).toBe("stale");
      expect(outage.meta.source.status).toBe("unavailable");
      expect(outage.meta.source.freshness.state).toBe("unknown");
    });

    it("preserves mixed algorithm provenance", async () => {
      const history = await harness.create("mixed").historyNetwork(contractFilters(harness.date));
      expect(history.meta.provenance.kind).toBe("mixed");
      if (history.meta.provenance.kind === "mixed") expect(history.meta.provenance.versions.length).toBeGreaterThan(1);
    });
  });
}

const fixtureHarness: AdapterHarness = {
  date: "2026-08-24",
  create(scenario) {
    const fixtureScenario = scenario === "mixed" ? "mixed-versions" : scenario;
    return createFixtureAdapter(fixtureScenario);
  },
};

function histogram(index = 15, count = 9): number[] {
  const values = Array.from({ length: 72 }, () => 0);
  values[index] = count;
  return values;
}

function aggregateRow(serviceDate: string, scenario: ContractScenario): RawPostgresRow {
  return {
    service_date: serviceDate,
    scheduled_opportunities: 10,
    valid_delay_observations: 9,
    punctual_count: 7,
    signed_delay_sum: 900,
    canceled_count: 1,
    missing_evidence_count: 1,
    delay_histogram: histogram(),
    aggregate_algorithm_version: "v1",
    aggregate_algorithm_version_max: scenario === "mixed" ? "v2" : "v1",
  };
}

function lineRow(slug = "c1"): RawPostgresRow {
  return { slug, public_code: slug.toUpperCase(), name_es: slug.toUpperCase(), name_en: slug.toUpperCase(), color: "5aa1d8" };
}

function stationRow(id: string, suffix = ""): RawPostgresRow {
  return {
    public_id: id,
    slug_es: `${id}${suffix}`,
    slug_en: `${id}${suffix}`,
    name_es: id === "atocha" ? "Atocha" : "Chamartín",
    name_en: id === "atocha" ? "Atocha" : "Chamartín",
  };
}

function topologyRows(): RawPostgresRow[] {
  const station = (pattern: string, branch: string, direction: 0 | 1, order: number, id: string): RawPostgresRow => ({
    pattern_id: pattern,
    branch_slug: branch,
    direction,
    stop_order: order,
    station_id: id,
    station_slug_es: id,
    station_slug_en: id,
    station_name_es: id === "atocha" ? "Atocha" : "Chamartín",
    station_name_en: id === "atocha" ? "Atocha" : "Chamartín",
  });
  return [
    station("c1-main-0", "main", 0, 1, "chamartin"),
    station("c1-main-0", "main", 0, 2, "atocha"),
    station("c1-main-1", "main", 1, 1, "atocha"),
    station("c1-main-1", "main", 1, 2, "chamartin"),
  ];
}

function vehicleRows(serviceDate: string, capturedAt: string): RawPostgresRow[] {
  const base = {
    captured_at: capturedAt,
    service_date: serviceDate,
    line_slug: "c1",
    public_code: "C1",
    line_name_es: "C1",
    line_name_en: "C1",
    current_stop_sequence: 2,
    current_station_id: "atocha",
    current_station_slug_es: "atocha",
    current_station_slug_en: "atocha",
    current_station_name_es: "Atocha",
    current_station_name_en: "Atocha",
    latest_stop_delay: 180,
    vehicle_timestamp: capturedAt,
  };
  return [
    { ...base, state_key: "train-stopped", source_trip_id: "trip-101", vehicle_id: "101", current_status: "STOPPED_AT", journey_id: 101 },
    { ...base, state_key: "train-moving", source_trip_id: "trip-102", vehicle_id: "102", current_status: "IN_TRANSIT", journey_id: 102 },
  ];
}

function matrixRows(serviceDate: string): RawPostgresRow[] {
  return ["chamartin", "atocha"].map((stationId, index) => ({
    service_date: serviceDate,
    journey_id: 101,
    source_trip_id: "trip-101",
    direction: 0,
    stop_sequence: index + 1,
    station_id: stationId,
    station_slug_es: stationId,
    station_slug_en: stationId,
    station_name_es: stationId === "atocha" ? "Atocha" : "Chamartín",
    station_name_en: stationId === "atocha" ? "Atocha" : "Chamartín",
    scheduled_arrival_at: `${serviceDate}T08:0${index}:00Z`,
    renfe_arrival_at: `${serviceDate}T08:0${index}:30Z`,
    selected_delay_seconds: 30,
    evidence_status: "reported_only",
    evidence_selected_captured_at: `${serviceDate}T08:00:00Z`,
  }));
}

const postgresConfig: WebServerConfig = {
  mode: "postgres",
  fixtureScenario: "healthy",
  fixtureScenarioOverridesEnabled: false,
  databaseUrl: "postgres://example.invalid/atodotren",
  databaseSslMode: "verify-full",
  databaseSslCa: null,
  poolMax: 1,
  statementTimeoutMs: 5_000,
};

function postgresHarness(): AdapterHarness {
  const date = currentMadridDate();
  return {
    date,
    create(scenario) {
      const capturedAt = scenario === "stale" ? new Date(Date.now() - 10 * 60_000).toISOString() : new Date().toISOString();
      const client: PostgresClient = {
        async query(text, values = []) {
          if (text.includes("api.catalog_search")) return [{ entity_kind: "station", stable_id: "atocha", slug_es: "atocha", slug_en: "atocha", public_code: null, name_es: "Atocha", name_en: "Atocha" }];
          if (text.includes("api.schematic_pattern_stop")) return topologyRows();
          if (text.includes("api.live_health")) return scenario === "outage" ? [] : [{ latest_successful_poll_at: capturedAt }];
          if (text.includes("api.live_vehicle")) return vehicleRows(date, capturedAt);
          if (text.includes("api.service_day_state")) {
            const dates = Array.isArray(values[0]) ? values[0] as string[] : [date];
            return dates.map((serviceDate) => ({ service_date: serviceDate, aggregate_algorithm_version: scenario === "mixed" ? "v2" : "v1", status: "verified", finalized_at: `${serviceDate}T23:00:00Z` }));
          }
          if (text.includes("api.recent_line_matrix")) return matrixRows(date);
          if (text.includes("GROUP BY history.line_slug")) return [{ line_slug: "c1", public_code: "C1", valid_delay_observations: 150, punctual_count: 120, signed_delay_sum: 9000 }];
          if (text.includes("sum(valid_delay_observations)::bigint AS valid_delay_observations") && (text.includes("api.history_line_hour") || text.includes("api.history_station_hour"))) {
            return [{ valid_delay_observations: 40, punctual_count: 30, signed_delay_sum: 2400 }];
          }
          if (text.includes("WITH filtered")) return [aggregateRow(date, scenario)];
          if (text.includes("api.history_network_day")) return [aggregateRow(date, scenario)];
          if (text.includes("api.history_line_day")) return [aggregateRow(date, scenario)];
          if (text.includes("api.history_station_hour")) return [aggregateRow(date, scenario)];
          if (text.includes("api.line_catalog")) {
            const slug = typeof values[1] === "string" ? values[1] : null;
            return slug === null || slug === "c1" ? [lineRow("c1")] : [];
          }
          if (text.includes("api.station_catalog")) {
            const key = typeof values[1] === "string" ? values[1] : "atocha";
            return key === "atocha" ? [stationRow("atocha")] : [];
          }
          throw new Error(`Unexpected PostgreSQL contract query: ${text}`);
        },
        close: async () => undefined,
      };
      return createPostgresAdapter(postgresConfig, client);
    },
  };
}

publicDataAdapterContract("fixture", fixtureHarness);
publicDataAdapterContract("postgres", postgresHarness());
