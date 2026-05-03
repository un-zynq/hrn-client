importScripts(
  "https://storage.googleapis.com/workbox-cdn/releases/7.0.0/workbox-sw.js",
);

if (workbox) {
  const CACHE_VERSION = "v10";
  workbox.core.setCacheNameDetails({
    prefix: "eaglercraft",
    suffix: CACHE_VERSION,
    precache: "precache",
    runtime: "runtime",
  });

  workbox.core.skipWaiting();
  workbox.core.clientsClaim();

  workbox.precaching.precacheAndRoute([
    { url: "bootstrap.js", revision: CACHE_VERSION },
    { url: "list.json", revision: CACHE_VERSION },
    { url: "game-assets/meta.json", revision: CACHE_VERSION },
    { url: "lib/largeEPK.js", revision: CACHE_VERSION },
    { url: "lib/launcher.js", revision: CACHE_VERSION },
    { url: "lib/sha256.js", revision: CACHE_VERSION },
    { url: "lib/util.js", revision: CACHE_VERSION },
    { url: "lib/wispcraft.js", revision: CACHE_VERSION },
    { url: "settings/wisp_urls.json", revision: CACHE_VERSION },
  ]);

  // Navigation: NetworkFirst with offline fallback
  const navigationHandler = async (params) => {
    try {
      return await workbox.strategies
        .NetworkFirst({
          cacheName: "eaglercraft-html",
        })
        .handle(params);
    } catch (error) {
      return caches.match("index.html");
    }
  };

  workbox.routing.registerRoute(
    ({ request, url }) =>
      request.mode === "navigate" || url.pathname.endsWith("index.html"),
    navigationHandler,
  );

  // Scripts and styles: StaleWhileRevalidate (small files, fast to revalidate)
  workbox.routing.registerRoute(
    ({ request }) =>
      request.destination === "script" || request.destination === "style",
    new workbox.strategies.StaleWhileRevalidate({
      cacheName: "eaglercraft-assets",
    }),
  );

  // .seg segment files: CacheFirst with 7-day expiration
  // These are large (total ~100MB) and don't change between versions.
  // The app handles freshness via SHA-256 hash comparison in meta.json,
  // so StaleWhileRevalidate is wasteful — it re-downloads all 100MB in the background on every visit.
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
          maxAgeSeconds: 7 * 24 * 60 * 60, // 7 days
          maxEntries: 20,
        }),
      ],
    }),
  );

  // .epk and .epw files: CacheFirst (large, hash-based freshness)
  workbox.routing.registerRoute(
    ({ url }) => url.pathname.endsWith(".epk") || url.pathname.endsWith(".epw"),
    new workbox.strategies.CacheFirst({
      cacheName: "eaglercraft-epk",
      plugins: [
        new workbox.cacheableResponse.CacheableResponsePlugin({
          statuses: [0, 200],
        }),
        new workbox.rangeRequests.RangeRequestsPlugin(),
        new workbox.expiration.ExpirationPlugin({
          maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
        }),
      ],
    }),
  );

  // JSON: NetworkFirst (small files, should be fresh)
  workbox.routing.registerRoute(
    ({ url }) => url.pathname.endsWith(".json"),
    new workbox.strategies.NetworkFirst({ cacheName: "eaglercraft-json" }),
  );
}
