import "server-only";

import type { PublicDataAdapter } from "../data-adapter";
import type { WebServerConfig } from "../config";
import { createPostgresClient, type PostgresClient } from "./client";
import { createCatalogRepository } from "./catalog-repository";
import { createHistoryRepository } from "./history-repository";
import { createJourneyRepository } from "./journey-repository";
import { createLiveRepository } from "./live-repository";
import { createMatrixRepository } from "./matrix-repository";
import { createMetadataRepository } from "./metadata-repository";
import { createTopologyRepository } from "./topology-repository";

export function createPostgresAdapter(config: WebServerConfig, clientOverride?: PostgresClient): PublicDataAdapter {
  const client = clientOverride ?? createPostgresClient(config);
  const catalog = createCatalogRepository(client);
  const metadata = createMetadataRepository(client);
  const topology = createTopologyRepository(client);
  const live = createLiveRepository(client, catalog, metadata, topology);
  const history = createHistoryRepository(client, catalog, metadata, topology);
  const journey = createJourneyRepository(client, catalog);
  const matrix = createMatrixRepository(client, catalog, metadata);

  return {
    search: (query) => catalog.search(query),
    liveNetwork: () => live.network(),
    liveLine: (slug) => live.line(slug),
    liveStation: (slug) => live.station(slug),
    journey: (serviceDate, journeyId) => journey.get(serviceDate, journeyId),
    historyNetwork: (filters) => history.network(filters),
    historyLine: (slug, filters) => history.line(slug, filters),
    historyStation: (slug, filters) => history.station(slug, filters),
    matrix: (lineSlug, serviceDate) => matrix.get(lineSlug, serviceDate),
    close: () => client.close(),
  };
}
