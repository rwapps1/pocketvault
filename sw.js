// sw.js — PocketVault service worker (lets Chrome install the app and
// lets it open without signal).
//
// PocketVault is one page: files are only fetched when the app starts
// (and the mini apps are pre-fetched just after), never on each tap.
// For each file: ask GitHub for the latest copy, but if that takes more
// than 3 seconds (weak signal) use the saved copy instead, so the app
// never hangs. Firebase and fonts are left alone.
// Bump CACHE with each upload that changes the file list.

const CACHE = "pocketvault-v18";
const CORE = [
  "./",
  "./index.html",
  "./app.css",
  "./shell.js",
  "./main.js",
  "./app.js",
  "./lock.js",
  "./auth-guard.js",
  "./vault.html", "./vault.js",
  "./bills.html", "./bills.js", "./bills-data.js",
  "./investments.html", "./investments.js", "./investments-data.js",
  "./holidays.html", "./holidays.js", "./holidays-data.js",
  "./earnings.html", "./earnings.js", "./earnings-data.js",
  "./manifest.json",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png"
];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                               // Firebase, fonts
  if (!url.pathname.startsWith(new URL("./", self.location).pathname)) return;   // other repos

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(req, { cache: "no-cache" }).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    const cached = await cache.match(req, { ignoreSearch: true });
    if (!cached) {
      try { return await network; }
      catch { return (await cache.match("./index.html")) || Response.error(); }
    }
    // Race the network against a timer; fall back to the saved copy.
    const timeout = new Promise((res) => setTimeout(() => res(null), NETWORK_TIMEOUT_MS));
    try {
      const winner = await Promise.race([network, timeout]);
      return winner || cached;
    } catch {
      return cached;
    }
  })());
});
