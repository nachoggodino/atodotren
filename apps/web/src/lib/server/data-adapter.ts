import type { HistoryFilters, HistoryResponse, LiveContextResponse, LiveNetworkResponse, MatrixResult, SearchResult, TrainDetail } from "@/lib/domain/contracts";

export interface PublicDataAdapter {
  search(query: string): Promise<readonly SearchResult[]>;
  liveNetwork(): Promise<LiveNetworkResponse>;
  liveLine(slug: string): Promise<LiveContextResponse | null>;
  liveStation(slug: string): Promise<LiveContextResponse | null>;
  journey(serviceDate: string, journeyId: string): Promise<TrainDetail | null>;
  historyNetwork(filters: HistoryFilters): Promise<HistoryResponse>;
  historyLine(slug: string, filters: HistoryFilters): Promise<HistoryResponse | null>;
  historyStation(slug: string, filters: HistoryFilters): Promise<HistoryResponse | null>;
  matrix(lineSlug: string, serviceDate: string): Promise<MatrixResult>;
  close?(): Promise<void>;
}
