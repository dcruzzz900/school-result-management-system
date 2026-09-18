const CACHE_NAME = "school-results-shell-v3";
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

// Multi-school isolation: a cache hit is served with zero server contact,
// so — unlike localStorage, which the app can namespace per school itself
// — a page cached while logged in as School A could otherwise be served
// right back when School B logs in on the same device and goes offline.
// login.html sends this the moment it detects the school that just logged
// in differs from the one last active on this device, so a school switch
// always starts from a clean cache rather than relying on nobody guessing
// the previous account's password at the offline lock screen.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "CLEAR_CACHE") {
    event.waitUntil(caches.delete(CACHE_NAME));
  }
});

// Network-first for EVERYTHING, including static assets (css/icons). This
// app changes frequently, so we always want the latest CSS/JS/icons when
// the phone is online — the cache is only a fallback for when it's offline,
// not a way to skip fetching fresh files. (An earlier version of this file
// used cache-first for /static/, which caused phones to get stuck showing
// an old stylesheet indefinitely — this fixes that.)
//
// GET page responses (Score Entry, Roll Call, admin lists, etc.) are cached
// the same way static assets are, so a page that's been opened at least
// once while online can be reopened with zero connectivity — not just have
// its form submission queued by offline-queue.js. Only same-origin GET
// requests are ever cached; POSTs are left alone so a failed form
// submission surfaces as a normal network error to the caller instead of
// silently getting a cached page back as its "response". Non-HTML,
// non-static responses (generated PDFs, CSV/XLSX exports) are skipped too
// — a stale copy of those isn't useful offline and they can be large.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  const isStatic = url.pathname.startsWith("/static/");

  event.respondWith(
    fetch(req)
      .then((response) => {
        const type = response.headers.get("Content-Type") || "";
        if (response.ok && (isStatic || type.includes("text/html"))) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(req).then(
          (cached) =>
            cached ||
            new Response(
              "<h2 style='font-family:sans-serif;padding:2rem;'>You're offline and this page hasn't been opened on this device before, so it isn't available yet. Open it once while connected, and it'll work offline after that.</h2>",
              { headers: { "Content-Type": "text/html" } }
            )
        )
      )
  );
});
