import type { MatrixResult } from "./contracts";
import type { Messages } from "@/messages/types";

export function matrixResultMessage(result: MatrixResult | null, messages: Messages): string | null {
  if (result === null || result.status === "available") return null;
  if (result.status === "failed") return messages.history.matrixFailed;
  if (result.reason === "retention") return messages.history.matrixRetention;
  return messages.history.matrixNoData;
}
