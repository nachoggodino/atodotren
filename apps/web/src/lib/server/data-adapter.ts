import type { HistoryFilters, HistoryResponse, LandingOverviewResponse, LiveContextResponse, LiveNetworkResponse, LiveStationResponse, MatrixResult, SearchResult, TrainDetail } from "@/lib/domain/contracts";

export interface PublicDataAdapter {
  search(query: string): Promise<readonly SearchResult[]>;
  landingOverview(): Promise<LandingOverviewResponse>;
  liveNetwork(): Promise<LiveNetworkResponse>;
  liveLine(slug: string): Promise<LiveContextResponse | null>;
  liveStation(slug: string): Promise<LiveStationResponse | null>;
  journey(serviceDate: string, journeyId: string): Promise<TrainDetail | null>;
  historyNetwork(filters: HistoryFilters): Promise<HistoryResponse>;
  historyLine(slug: string, filters: HistoryFilters): Promise<HistoryResponse | null>;
  historyStation(slug: string, filters: HistoryFilters): Promise<HistoryResponse | null>;
  matrix(lineSlug: string, serviceDate: string): Promise<MatrixResult>;
  close?(): Promise<void>;
}
