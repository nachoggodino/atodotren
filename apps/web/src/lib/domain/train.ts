import type { TrainPosition } from "./contracts";

export type PositionCaptionKey = "reported" | "inferred" | "unavailable";

export function positionCaptionKey(position: TrainPosition): PositionCaptionKey {
  switch (position.basis) {
    case "reported-stop": return "reported";
    case "feed-inferred":
    case "schedule-inferred": return "inferred";
    case "unavailable": return "unavailable";
  }
}
