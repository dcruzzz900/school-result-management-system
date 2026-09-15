const CACHE_NAME = "school-results-shell-v2";
const SHELL_ASSETS = [
  "/static/css/style.css",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Network-first for EVERYTHING, including static assets (css/icons). This
// app changes frequently, so we always want the latest CSS/JS/icons when
// the phone is online — the cache is only a fallback for when it's offline,
// not a way to skip fetching fresh files. (An earlier version of this file
// used cache-first for /static/, which caused phones to get stuck showing
// an old stylesheet indefinitely — this fixes that.)
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.pathname.startsWith("/static/")) {
    event.respondWith(
      fetch(req)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return response;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    fetch(req).catch(() =>
      caches.match(req).then(
        (cached) =>
          cached ||
          new Response(
            "<h2 style='font-family:sans-serif;padding:2rem;'>You're offline. Please reconnect to use the School Result System.</h2>",
            { headers: { "Content-Type": "text/html" } }
          )
      )
    )
  );
});
