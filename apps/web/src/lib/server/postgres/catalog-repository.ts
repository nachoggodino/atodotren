import type { LineRef, SearchResult, StationRef } from "@/lib/domain/contracts";
import { DataContractError } from "@/lib/domain/errors";
import { MADRID_NETWORK } from "@/lib/domain/network";
import { SEARCH_RESULT_LIMIT } from "@/lib/domain/search";
import type { PostgresClient } from "./client";
import { lineFromCatalogRow, stationFromCatalogRow } from "./mappers/catalog";
import { parseLineCatalogRow, parseSearchRow, parseStationCatalogRow } from "./row-parser";

export interface CatalogRepository {
  lines(): Promise<readonly LineRef[]>;
  line(slug: string): Promise<LineRef | null>;
  station(slug: string): Promise<StationRef | null>;
  search(query: string): Promise<readonly SearchResult[]>;
}

export function createCatalogRepository(client: PostgresClient): CatalogRepository {
  async function lines(): Promise<readonly LineRef[]> {
    const rows = await client.query(
      "SELECT * FROM api.line_catalog WHERE network_slug = $1 ORDER BY display_order, public_code",
      [MADRID_NETWORK.slug],
    );
    return rows.map(parseLineCatalogRow).map(lineFromCatalogRow);
  }

  return {
    lines,
    async line(slug) {
      const rows = await client.query(
        "SELECT * FROM api.line_catalog WHERE network_slug = $1 AND slug = $2",
        [MADRID_NETWORK.slug, slug],
      );
      if (rows.length > 1) throw new DataContractError("api.line_catalog", `duplicate line slug ${slug}`);
      return rows[0] === undefined ? null : lineFromCatalogRow(parseLineCatalogRow(rows[0]));
    },
    async station(slug) {
      const rows = await client.query(
        "SELECT * FROM api.station_catalog WHERE network_slug = $1 AND (slug_es = $2 OR slug_en = $2 OR public_id = $2)",
        [MADRID_NETWORK.slug, slug],
      );
      if (rows.length > 1) throw new DataContractError("api.station_catalog", `ambiguous station key ${slug}`);
      return rows[0] === undefined ? null : stationFromCatalogRow(parseStationCatalogRow(rows[0]));
    },
    async search(searchTerm) {
      const rows = await client.query("SELECT * FROM api.catalog_search($1, $2)", [searchTerm, SEARCH_RESULT_LIMIT]);
      return rows.map(parseSearchRow).map<SearchResult>((row) => ({
        kind: row.kind,
        id: row.id,
        slug: { es: row.slugEs, en: row.slugEn },
        code: row.code,
        name: { es: row.nameEs, en: row.nameEn },
      }));
    },
  };
}
