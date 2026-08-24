const VERSION = "frontend-alpha-v1";
const SHELL_CACHE = `atodotren-shell-${VERSION}`;
const LIVE_CACHE = `atodotren-live-${VERSION}`;
const DAILY_CACHE = `atodotren-daily-${VERSION}`;
const PAGE_CACHE = `atodotren-page-${VERSION}`;
const OWNED_PREFIX = "atodotren-";

const SHELL_URLS = ["/es", "/en", "/offline.html", "/icon.svg", "/maskable.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(OWNED_PREFIX) && ![SHELL_CACHE, LIVE_CACHE, DAILY_CACHE, PAGE_CACHE].includes(name)).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

function withCachedAt(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Atodotren-Cached-At", new Date().toISOString());
  return response.clone().arrayBuffer().then((body) => new Response(body, { status: response.status, statusText: response.statusText, headers }));
}

async function offlineResponse(response) {
  if (!response) return null;
  const headers = new Headers(response.headers);
  headers.set("X-Atodotren-Cache", "offline");
  return new Response(await response.clone().arrayBuffer(), { status: response.status, statusText: response.statusText, headers });
}

async function storeSingle(cacheName, request, response, preserve = () => false) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  await Promise.all(keys.filter((key) => !preserve(key)).map((key) => cache.delete(key)));
  await cache.put(request, await withCachedAt(response));
}

function isLiveApi(url) {
  return url.origin === self.location.origin && /^\/api\/v1\/live\/(network|lines\/[^/]+|stations\/[^/]+)$/.test(url.pathname);
}

function isDailySummary(url) {
  if (url.origin !== self.location.origin || url.pathname !== "/api/v1/history/network") return false;
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  return from !== null && from === to;
}

function isLivePage(url) {
  return url.origin === self.location.origin && /^\/(es|en)\/live(?:\/|$)/.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  if (isLiveApi(url)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          const isNetwork = url.pathname.endsWith("/network");
          await storeSingle(LIVE_CACHE, event.request, response.clone(), (key) => isNetwork ? false : new URL(key.url).pathname.endsWith("/network"));
        }
        return response;
      } catch {
        return (await offlineResponse(await caches.match(event.request))) ?? new Response(JSON.stringify({ error: "offline-no-cache" }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      }
    })());
    return;
  }

  if (isDailySummary(url)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok) await storeSingle(DAILY_CACHE, event.request, response.clone());
        return response;
      } catch {
        return (await offlineResponse(await caches.match(event.request))) ?? new Response(JSON.stringify({ error: "offline-no-cache" }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      }
    })());
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok && isLivePage(url)) await storeSingle(PAGE_CACHE, event.request, response.clone());
        return response;
      } catch {
        const exact = await caches.match(event.request);
        if (exact) return offlineResponse(exact);
        const shell = await caches.match(url.pathname.startsWith("/en") ? "/en" : "/es");
        if (/^\/(es|en)$/.test(url.pathname) && shell) return offlineResponse(shell);
        return (await caches.match("/offline.html")) ?? new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
  }
});
