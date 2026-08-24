import { apiError, apiJson, scenarioFromRequest } from "@/lib/server/api";
import { getLiveLine } from "@/lib/server/services";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { readonly params: Promise<{ slug: string }> }) { const { slug } = await params; if (!/^[a-z0-9-]{1,40}$/.test(slug)) return apiError("Invalid line slug"); const data = await getLiveLine(slug, scenarioFromRequest(request)); return data === null ? apiError("Line not found", 404) : apiJson(data, 30); }
