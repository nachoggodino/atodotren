import "server-only";

interface CacheEntry<T> { readonly expiresAt: number; readonly value: T }
const store = new Map<string, CacheEntry<unknown>>();

export async function withTtlCache<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const existing = store.get(key) as CacheEntry<T> | undefined;
  if (existing !== undefined && existing.expiresAt > now) return existing.value;
  const value = await loader();
  store.set(key, { expiresAt: now + ttlSeconds * 1000, value });
  if (store.size > 250) {
    for (const [entryKey, entry] of store) if (entry.expiresAt <= now) store.delete(entryKey);
  }
  return value;
}
