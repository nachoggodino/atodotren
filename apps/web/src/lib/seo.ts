export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): URL | null {
  const raw = env.WEB_PUBLIC_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const value = new URL(raw);
    return value.protocol === "https:" || value.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}
