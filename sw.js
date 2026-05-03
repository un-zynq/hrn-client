try {
  importScripts("https://storage.googleapis.com/workbox-cdn/releases/7.0.0/workbox-sw.js");
} catch (e) {
  importScripts("/lib/workbox-sw.js");
}

const CACHE_VERSION = "v10";

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

  workbox.precaching.precacheAndRoute(
    [
      { url: "bootstrap.js", revision: CACHE_VERSION },
      { url: "list.json", revision: CACHE_VERSION },
      { url: "game-assets/meta.json", revision: CACHE_VERSION },
      { url: "lib/largeEPK.js", revision: CACHE_VERSION },
      { url: "lib/launcher.js", revision: CACHE_VERSION },
      { url: "lib/sha256.js", revision: CACHE_VERSION },
      { url: "lib/util.js", revision: CACHE_VERSION },
      { url: "lib/wispcraft.js", revision: CACHE_VERSION },
      { url: "settings/wisp_urls.json", revision: CACHE_VERSION },
      { url: "index.html", revision: CACHE_VERSION }
    ],
    {
      fallbackToNetwork: true
    }
  );

  const safeFallback = async (params) => {
    try {
      const res = await workbox.strategies.NetworkFirst({
        cacheName: "eaglercraft-html",
        networkTimeoutSeconds: 3
      }).handle(params);

      if (res) return res;

      return (await caches.match("index.html")) || fetch("index.html");
    } catch (e) {
      return (await caches.match("index.html")) || fetch("index.html");
    }
  };

  workbox.routing.registerRoute(
    ({ request }) => request.mode === "navigate",
    safeFallback
  );

  workbox.routing.registerRoute(
    ({ request }) =>
      request.destination === "script" || request.destination === "style",
    new workbox.strategies.StaleWhileRevalidate({
      cacheName: "eaglercraft-assets",
    })
  );

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

  workbox.routing.registerRoute(
    ({ url }) =>
      url.pathname.endsWith(".epk") || url.pathname.endsWith(".epw"),
    new workbox.strategies.CacheFirst({
      cacheName: "eaglercraft-epk",
      plugins: [
        new workbox.cacheableResponse.CacheableResponsePlugin({
          statuses: [0, 200],
        }),
        new workbox.rangeRequests.RangeRequestsPlugin(),
        new workbox.expiration.ExpirationPlugin({
          maxAgeSeconds: 30 * 24 * 60 * 60,
        }),
      ],
    })
  );

  workbox.routing.registerRoute(
    ({ url }) => url.pathname.endsWith(".json"),
    new workbox.strategies.NetworkFirst({
      cacheName: "eaglercraft-json",
    })
  );
}
