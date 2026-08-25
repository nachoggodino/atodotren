import "server-only";

interface CacheEntry<T> { readonly value: T; readonly expiresAt: number }

const MAX_CACHE_ENTRIES = 250;
const store = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

function evictExpired(now: number): void {
  for (const [key, entry] of store) if (entry.expiresAt <= now) store.delete(key);
}

function enforceBound(): void {
  while (store.size > MAX_CACHE_ENTRIES) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export async function getCached<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const existing = store.get(key) as CacheEntry<T> | undefined;
  if (existing !== undefined && existing.expiresAt > now) return existing.value;
  if (existing !== undefined) store.delete(key);

  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running !== undefined) return running;

  const promise = loader()
    .then((value) => {
      if (ttlSeconds > 0) {
        evictExpired(Date.now());
        store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
        enforceBound();
      }
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

export function cacheKey(parts: readonly unknown[]): string {
  return parts.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join("|");
}
