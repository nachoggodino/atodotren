import type { TrainDetail } from "@/lib/domain/contracts";
import { currentMadridDate, isCalendarDate, offsetCalendarDate } from "@/lib/domain/dates";
import { DataUnavailableError, ValidationError } from "@/lib/domain/errors";
import type { CatalogRepository } from "./catalog-repository";
import type { PostgresClient } from "./client";
import { journeyFromRows } from "./mappers/train";
import { parseJourneyRow } from "./row-parser";

const DETAILED_RETENTION_DAYS = 30;
const JOURNEY_DATABASE_MAX_ROWS = 250;

export interface JourneyRepository { get(serviceDate: string, journeyId: string, now?: Date): Promise<TrainDetail | null> }

export function createJourneyRepository(client: PostgresClient, catalog: CatalogRepository): JourneyRepository {
  return {
    async get(serviceDate, journeyId, now = new Date()) {
      if (!isCalendarDate(serviceDate)) throw new ValidationError("Invalid journey service date", "invalid-service-date");
      if (!/^\d+$/.test(journeyId)) return null;
      const today = currentMadridDate(now);
      if (serviceDate < offsetCalendarDate(today, -DETAILED_RETENTION_DAYS) || serviceDate > today) throw new DataUnavailableError("Journey detail is outside the retention window", "retention");
      const rawRows = await client.query("SELECT * FROM api.recent_journey($1::date, $2::bigint)", [serviceDate, journeyId]);
      if (rawRows.length >= JOURNEY_DATABASE_MAX_ROWS) throw new DataUnavailableError("Journey result reached its safety bound", "result-too-large");
      const rows = rawRows.map(parseJourneyRow);
      const first = rows[0];
      if (first === undefined) return null;
      const line = await catalog.line(first.lineSlug);
      if (line === null) throw new Error(`Journey references missing line ${first.lineSlug}`);
      return journeyFromRows(rows, line);
    },
  };
}
