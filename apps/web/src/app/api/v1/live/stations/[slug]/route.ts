import { apiError, apiJson, scenarioFromRequest } from "@/lib/server/api";
import { getLiveStation } from "@/lib/server/services";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { readonly params: Promise<{ slug: string }> }) { const { slug } = await params; if (!/^[a-z0-9-]{1,80}$/.test(slug)) return apiError("Invalid station slug"); const data = await getLiveStation(slug, scenarioFromRequest(request)); return data === null ? apiError("Station not found", 404) : apiJson(data, 30); }
