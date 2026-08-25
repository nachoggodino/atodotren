import { NextResponse } from "next/server";

export function apiJson<T>(value: T, maxAgeSeconds: number): NextResponse<T> {
  return NextResponse.json(value, { headers: { "Cache-Control": `public, max-age=0, s-maxage=${maxAgeSeconds}, stale-while-revalidate=${Math.max(30, maxAgeSeconds)}` } });
}

export function apiError(message: string, status: 400 | 404 | 500 = 400) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export function scenarioFromRequest(request: Request): string | undefined {
  const value = new URL(request.url).searchParams.get("scenario")?.trim();
  return value === "" || value === undefined ? undefined : value;
}
