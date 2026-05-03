try {
  importScripts("https://storage.googleapis.com/workbox-cdn/releases/7.0.0/workbox-sw.js");
} catch (e) {
  importScripts("/lib/workbox-sw.js");
}

const CACHE_VERSION = "v15";

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

  // 📦 PRECACHE (NO sw.js)
  workbox.precaching.precacheAndRoute([
    { url: "index.html", revision: CACHE_VERSION },
    { url: "list.json", revision: CACHE_VERSION },
    { url: "bootstrap.js", revision: CACHE_VERSION },

    { url: "settings/index.html", revision: CACHE_VERSION },
    { url: "settings/wisp_urls.json", revision: CACHE_VERSION },
    { url: "settings/wisp_select.html", revision: CACHE_VERSION },

    { url: "support/cannot_connect_to_shared_world.html", revision: CACHE_VERSION },

    { url: "background.jpg", revision: CACHE_VERSION },
    { url: "meta.json", revision: CACHE_VERSION },
    { url: "game-assets/meta.json", revision: CACHE_VERSION },

    { url: "lib/largeEPK.js", revision: CACHE_VERSION },
    { url: "lib/launcher.js", revision: CACHE_VERSION },
    { url: "lib/sha256.js", revision: CACHE_VERSION },
    { url: "lib/util.js", revision: CACHE_VERSION },
    { url: "lib/wispcraft.js", revision: CACHE_VERSION },

    { url: "assets.epw.0.seg", revision: CACHE_VERSION },
    { url: "assets.epw.1.seg", revision: CACHE_VERSION },
    { url: "assets.epw.2.seg", revision: CACHE_VERSION },
    { url: "assets.epw.3.seg", revision: CACHE_VERSION },
    { url: "assets.epw.4.seg", revision: CACHE_VERSION },
    { url: "assets.epw.5.seg", revision: CACHE_VERSION },
  ]);

  // 🌐 SETTINGS
  workbox.routing.registerRoute(
    ({ url }) => url.pathname.startsWith("/settings"),
    async () => {
      return (
        (await caches.match("settings/index.html")) ||
        fetch("settings/index.html")
      );
    }
  );

  // 🌐 NAVIGATION
  workbox.routing.registerRoute(
    ({ request }) => request.mode === "navigate",
    async (params) => {
      try {
        const url = new URL(params.request.url);

        if (url.pathname.startsWith("/settings")) {
          return (
            (await caches.match("settings/index.html")) ||
            fetch("settings/index.html")
          );
        }

        return (
          (await caches.match("index.html")) ||
          fetch(params.request)
        );
      } catch (e) {
        return caches.match("index.html");
      }
    }
  );

  // 📜 JS
  workbox.routing.registerRoute(
    ({ request }) => request.destination === "script",
    new workbox.strategies.StaleWhileRevalidate({
      cacheName: "eaglercraft-js",
    })
  );

  // 🎨 images
  workbox.routing.registerRoute(
    ({ request }) => request.destination === "image",
    new workbox.strategies.CacheFirst({
      cacheName: "eaglercraft-images",
    })
  );

  // 📄 JSON
  workbox.routing.registerRoute(
    ({ url }) => url.pathname.endsWith(".json"),
    new workbox.strategies.NetworkFirst({
      cacheName: "eaglercraft-json",
    })
  );

  // 🧊 SEG ONLY
  workbox.routing.registerRoute(
    ({ url }) => url.pathname.endsWith(".seg"),
    new workbox.strategies.CacheFirst({
      cacheName: "eaglercraft-segments",
    })
  );

  // 📦 epk/epw
  workbox.routing.registerRoute(
    ({ url }) =>
      url.pathname.endsWith(".epw") || url.pathname.endsWith(".epk"),
    new workbox.strategies.CacheFirst({
      cacheName: "eaglercraft-epk",
    })
  );
}
