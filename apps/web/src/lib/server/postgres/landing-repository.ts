import type { LandingOverviewResponse } from "@/lib/domain/contracts";
import { DataContractError } from "@/lib/domain/errors";
import { MADRID_NETWORK } from "@/lib/domain/network";
import type { PostgresClient, RawPostgresRow } from "./client";
import type { LiveRepository } from "./live-repository";

function integerValue(value: unknown, context: string, field: string): number {
  if (typeof value !== "number" && typeof value !== "string") throw new DataContractError(context, `invalid ${field}: ${String(value)}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new DataContractError(context, `invalid ${field}: ${String(value)}`);
  return parsed;
}

function timestampValue(value: unknown, context: string, field: string): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) throw new DataContractError(context, `invalid ${field}: ${String(value)}`);
  return date.toISOString();
}

function activeJourneyDelay(rows: readonly RawPostgresRow[]): number {
  return rows.reduce((sum, row) => {
    const value = row.latest_usable_delay;
    if (value === null || value === undefined) return sum;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new DataContractError("api.active_live_vehicle", `invalid latest_usable_delay: ${String(value)}`);
    return sum + Math.max(0, parsed);
  }, 0);
}

export interface LandingRepository {
  overview(now?: Date): Promise<LandingOverviewResponse>;
}

export function createLandingRepository(client: PostgresClient, live: LiveRepository): LandingRepository {
  return {
    async overview(now = new Date()) {
      const [network, activeJourneyRows, timelineRows] = await Promise.all([
        live.network(now),
        client.query(
          `SELECT DISTINCT ON (COALESCE(journey_id::text, state_key)) latest_usable_delay
           FROM api.active_live_vehicle
           WHERE network_slug = $1
           ORDER BY COALESCE(journey_id::text, state_key), captured_at DESC`,
          [MADRID_NETWORK.slug],
        ),
        client.query("SELECT * FROM api.landing_delay_timeline($1, $2::timestamptz)", [MADRID_NETWORK.slug, now.toISOString()]),
      ]);
      const context = "api.landing_delay_timeline";
      let dayDelaySeconds = 0;
      const trend = timelineRows.map((row, index) => {
        const currentTotal = integerValue(row.current_accumulated_journey_delay_seconds, context, "current_accumulated_journey_delay_seconds");
        if (index === 0) dayDelaySeconds = currentTotal;
        else if (currentTotal !== dayDelaySeconds) throw new DataContractError(context, "inconsistent current_accumulated_journey_delay_seconds");
        const rawTotal = row.accumulated_journey_delay_seconds;
        return {
          at: timestampValue(row.bucket_at, context, "bucket_at"),
          totalDelaySeconds: rawTotal === null || rawTotal === undefined ? null : integerValue(rawTotal, context, "accumulated_journey_delay_seconds"),
        };
      });
      return {
        meta: network.meta,
        activeTrains: network.lines.reduce((sum, line) => sum + line.activeTrains, 0),
        activeDelaySeconds: activeJourneyDelay(activeJourneyRows),
        dayDelaySeconds,
        trend,
      };
    },
  };
}
