import type { SummaryStats } from "@/lib/domain/contracts";
import { historicalResponseMeta, liveResponseMeta } from "@/lib/domain/data-policy";
import { currentMadridDate, isCalendarDate } from "@/lib/domain/dates";
import { delayBucketForSeconds, distributionFromCounts, PUNCTUALITY_THRESHOLD_SECONDS } from "@/lib/domain/delay-policy";
import { apiError, apiJson, scenarioFromRequest, withApiErrorBoundary } from "@/lib/server/api";
import { LIVE_CACHE_SECONDS, getJourney } from "@/lib/server/services";

export const dynamic = "force-dynamic";
const MAX_BIGINT = 9_223_372_036_854_775_807n;

function validJourneyId(value: string): boolean {
  if (!/^\d{1,20}$/.test(value)) return false;
  try { return BigInt(value) <= MAX_BIGINT; } catch { return false; }
}

export async function GET(request: Request, { params }: { readonly params: Promise<{ serviceDate: string; journeyId: string }> }) {
  const { serviceDate, journeyId } = await params;
  if (!isCalendarDate(serviceDate) || !validJourneyId(journeyId)) return apiError("invalid-journey-identifier", "Invalid request", 400);
  return withApiErrorBoundary("live-journey", async () => {
    const train = await getJourney(serviceDate, journeyId, scenarioFromRequest(request));
    if (train === null) return apiError("journey-not-found", "Resource not found", 404);
    const observed = train.delaySeconds === null ? 0 : 1;
    const stats: SummaryStats = {
      scheduled: 1,
      observed,
      punctuality: observed === 0 ? null : train.delaySeconds! <= PUNCTUALITY_THRESHOLD_SECONDS ? 1 : 0,
      meanDelaySeconds: train.delaySeconds,
      medianDelaySeconds: train.delaySeconds,
      canceled: train.state === "canceled" ? 1 : 0,
      missing: train.state === "missing_evidence" ? 1 : 0,
      distribution: train.delaySeconds === null ? distributionFromCounts({}) : distributionFromCounts({ [delayBucketForSeconds(train.delaySeconds)]: 1 }),
    };
    const today = currentMadridDate();
    const provenance = { kind: "none" as const };
    const finalization = serviceDate === today ? { state: "processing" as const, finalizedAt: null } : { state: "unknown" as const, finalizedAt: null };
    const meta = serviceDate === today
      ? liveResponseMeta({ stats, sourceAt: train.sourceAt, activeTrains: 1, serviceDate, finalization, provenance, precision: train.position.basis === "unavailable" ? "mixed" : "schematic-inferred" })
      : historicalResponseMeta({ stats, serviceDate, finalization, provenance, precision: "mixed" });
    return apiJson({ meta, train }, LIVE_CACHE_SECONDS);
  });
}
