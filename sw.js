/* Rotation — Service Worker
   Network-first for the app shell (HTML/JS) so any redeploy is
   picked up immediately whenever the device is online, with a
   cache fallback so the app still works fully offline. A static
   asset (icons, manifest) uses cache-first since those rarely
   change and don't affect correctness.

   CACHE_NAME is bumped on every release. Bumping it is what
   forces old cached files to be discarded — without that, a
   fixed app.js can sit un-served behind a stale cache forever. */

const CACHE_NAME = "rotation-cache-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

const NETWORK_FIRST = new Set(["./", "./index.html", "./app.js"]);

function pathnameKey(url){
  const u = new URL(url, self.registration.scope);
  const rel = u.pathname.split("/").pop();
  return rel === "" ? "./" : "./" + rel;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const key = pathnameKey(event.request.url);
  const isShellDoc = NETWORK_FIRST.has(key);

  if (isShellDoc){
    // Network-first: always try to get the latest app.js/index.html
    // when online; only fall back to the cached copy if the network
    // request fails (i.e. truly offline).
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200){
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
    );
    return;
  }

  // Cache-first for everything else (icons, manifest, etc).
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === "basic"){
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => undefined);
    })
  );
});
