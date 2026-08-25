import "server-only";

interface CacheEntry<T> { readonly expiresAt: number; readonly value: T }
const MAX_CACHE_ENTRIES = 250;
const store = new Map<string, CacheEntry<unknown>>();

function prune(now: number): void {
  for (const [entryKey, entry] of store) if (entry.expiresAt <= now) store.delete(entryKey);
  while (store.size > MAX_CACHE_ENTRIES) {
    const oldestKey = store.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    store.delete(oldestKey);
  }
}

// Per-instance optimization only. Shared cache behavior belongs to HTTP/CDN caching.
export async function withTtlCache<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const existing = store.get(key) as CacheEntry<T> | undefined;
  if (existing !== undefined && existing.expiresAt > now) return existing.value;
  if (existing !== undefined) store.delete(key);
  prune(now);
  const value = await loader();
  store.set(key, { expiresAt: now + ttlSeconds * 1000, value });
  prune(now);
  return value;
}
