import { apiJson, scenarioFromRequest } from "@/lib/server/api";
import { getLiveNetwork } from "@/lib/server/services";

export const dynamic = "force-dynamic";
export async function GET(request: Request) { return apiJson(await getLiveNetwork(scenarioFromRequest(request)), 30); }
