import { NextResponse } from "next/server";
import { DataContractError, DataUnavailableError, NotFoundError, ValidationError } from "@/lib/domain/errors";
import { getWebServerConfig } from "./config";

export interface PublicApiError {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

type ErrorStatus = 400 | 404 | 410 | 500 | 503;

export function apiJson<T>(value: T, maxAgeSeconds: number): NextResponse<T> {
  return NextResponse.json(value, { headers: { "Cache-Control": `public, max-age=0, s-maxage=${maxAgeSeconds}, stale-while-revalidate=${Math.max(30, maxAgeSeconds)}` } });
}

export function apiError(code: string, message: string, status: ErrorStatus): NextResponse<PublicApiError> {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

export function mapApiError(error: unknown, context: string): NextResponse<PublicApiError> {
  if (error instanceof ValidationError) return apiError(error.code, "Invalid request", 400);
  if (error instanceof NotFoundError) return apiError(error.code, "Resource not found", 404);
  if (error instanceof DataUnavailableError) return apiError(error.code, "Requested data is unavailable", error.code === "retention" ? 410 : 404);
  if (error instanceof DataContractError) {
    console.error(`[web-api] data contract failure in ${context}`, error);
    return apiError("data-contract-failure", "Data is temporarily unavailable", 503);
  }
  console.error(`[web-api] unexpected failure in ${context}`, error);
  return apiError("service-unavailable", "Service temporarily unavailable", 503);
}

export async function withApiErrorBoundary<T extends Response>(context: string, handler: () => Promise<T>): Promise<T | NextResponse<PublicApiError>> {
  try {
    return await handler();
  } catch (error) {
    return mapApiError(error, context);
  }
}

export function scenarioFromRequest(request: Request): string | undefined {
  const config = getWebServerConfig();
  if (config.mode !== "fixture" || !config.fixtureScenarioOverridesEnabled) return undefined;
  const value = new URL(request.url).searchParams.get("scenario")?.trim();
  return value === "" || value === undefined ? undefined : value;
}
