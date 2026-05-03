try {
  importScripts("https://storage.googleapis.com/workbox-cdn/releases/7.0.0/workbox-sw.js");
} catch (e) {
  importScripts("/lib/workbox-sw.js");
}

const CACHE_VERSION = "v12";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (!key.includes(CACHE_VERSION)) {
            return caches.delete(key);
          }
        })
      );
      await self.clients.claim();
    })()
  );
});

if (self.workbox) {
  workbox.core.setCacheNameDetails({
    prefix: "eaglercraft",
    suffix: CACHE_VERSION,
    precache: "precache",
    runtime: "runtime",
  });

  workbox.core.skipWaiting();
  workbox.core.clientsClaim();

  // ❌ NO precache (everything dynamic)
  workbox.precaching.precacheAndRoute([]);

  // 🌐 HTML / navigation → ALWAYS network, no cache
  workbox.routing.registerRoute(
    ({ request }) => request.mode === "navigate",
    async (params) => {
      try {
        return await fetch(params.request);
      } catch (e) {
        return caches.match("index.html");
      }
    }
  );

  // ❌ scripts/styles: no cache
  workbox.routing.registerRoute(
    ({ request }) =>
      request.destination === "script" || request.destination === "style",
    async (params) => fetch(params.request)
  );

  // ❌ JSON: no cache
  workbox.routing.registerRoute(
    ({ url }) => url.pathname.endsWith(".json"),
    async (params) => fetch(params.request)
  );

  // ✅ ONLY .seg files cached
  workbox.routing.registerRoute(
    ({ url }) => url.pathname.endsWith(".seg"),
    new workbox.strategies.CacheFirst({
      cacheName: "eaglercraft-segments",
      plugins: [
        new workbox.cacheableResponse.CacheableResponsePlugin({
          statuses: [0, 200],
        }),
        new workbox.rangeRequests.RangeRequestsPlugin(),
        new workbox.expiration.ExpirationPlugin({
          maxAgeSeconds: 7 * 24 * 60 * 60,
          maxEntries: 20,
        }),
      ],
    })
  );
}
