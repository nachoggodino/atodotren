import type { DirectionDescriptor, SchematicPattern } from "@/lib/domain/contracts";
import { MADRID_NETWORK } from "@/lib/domain/network";
import type { PostgresClient } from "./client";
import { topologyFromRows } from "./mappers/catalog";
import { parseTopologyRow } from "./row-parser";

export interface TopologyRepository {
  patterns(lineSlug: string): Promise<readonly SchematicPattern[]>;
  directions(lineSlug: string): Promise<readonly DirectionDescriptor[]>;
}

export function createTopologyRepository(client: PostgresClient): TopologyRepository {
  async function patterns(lineSlug: string): Promise<readonly SchematicPattern[]> {
    const rows = await client.query(
      "SELECT * FROM api.schematic_pattern_stop WHERE network_slug = $1 AND line_slug = $2 ORDER BY pattern_id, stop_order",
      [MADRID_NETWORK.slug, lineSlug],
    );
    return topologyFromRows(rows.map(parseTopologyRow));
  }

  return {
    patterns,
    async directions(lineSlug) {
      const topology = await patterns(lineSlug);
      const byDirection = new Map<number, DirectionDescriptor>();
      for (const pattern of topology) if (!byDirection.has(pattern.direction.id)) byDirection.set(pattern.direction.id, pattern.direction);
      return [...byDirection.values()].sort((left, right) => left.id - right.id);
    },
  };
}
