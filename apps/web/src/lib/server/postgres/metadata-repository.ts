import type { AlgorithmProvenance, ResponseMeta } from "@/lib/domain/contracts";
import { algorithmProvenance, finalizationFromStates } from "@/lib/domain/data-policy";
import { currentMadridDate } from "@/lib/domain/dates";
import type { PostgresClient } from "./client";
import { parseServiceDayStateRow } from "./row-parser";

export interface ServiceDayMetadata {
  readonly finalization: ResponseMeta["finalization"];
  readonly provenance: AlgorithmProvenance;
}

export interface MetadataRepository {
  forDates(dates: readonly string[], now?: Date): Promise<ServiceDayMetadata>;
}

export function createMetadataRepository(client: PostgresClient): MetadataRepository {
  return {
    async forDates(dates, now = new Date()) {
      const uniqueDates = [...new Set(dates)].sort();
      if (uniqueDates.length === 0) {
        return { finalization: { state: "unknown", finalizedAt: null }, provenance: { kind: "none" } };
      }
      const rows = await client.query(
        "SELECT service_date, aggregate_algorithm_version, status, finalized_at FROM api.service_day_state WHERE service_date = ANY($1::date[]) ORDER BY service_date, aggregate_algorithm_version",
        [uniqueDates],
      );
      const parsed = rows.map(parseServiceDayStateRow);
      const current = currentMadridDate(now);
      const states = uniqueDates.map((date) => {
        const dateRows = parsed.filter((row) => row.serviceDate === date);
        if (dateRows.some((row) => row.status === "failed")) return { state: "unknown" as const, finalizedAt: null };
        const verified = dateRows.filter((row) => row.status === "verified");
        if (verified.length > 0) return { state: "finalized" as const, finalizedAt: verified.map((row) => row.finalizedAt).sort().at(-1) ?? null };
        if (date === current) return { state: "processing" as const, finalizedAt: null };
        return { state: "unknown" as const, finalizedAt: null };
      });
      return {
        finalization: finalizationFromStates(states),
        provenance: algorithmProvenance(parsed.map((row) => row.algorithmVersion)),
      };
    },
  };
}
