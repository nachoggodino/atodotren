import { apiError, apiJson, scenarioFromRequest } from "@/lib/server/api";
import { getMatrix } from "@/lib/server/services";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { readonly params: Promise<{ lineSlug: string }> }) { const { lineSlug } = await params; const url = new URL(request.url); const date = url.searchParams.get("date") ?? ""; if (!/^[a-z0-9-]{1,40}$/.test(lineSlug) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return apiError("Invalid matrix query"); try { const matrix = await getMatrix(lineSlug, date, scenarioFromRequest(request)); if (matrix === null) return apiError("Matrix not found", 404); return apiJson(matrix, matrix.meta.finalized ? 3_600 : 300); } catch (error) { return apiError(error instanceof Error ? error.message : "Matrix unavailable"); } }
