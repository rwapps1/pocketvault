// sw.js — PocketVault service worker
// Network-first for the app's own files (so a new upload shows straight
// away), falling back to the cached copy when offline. Firebase and font
// requests go straight to the network; Firestore handles its own offline cache.
// Bump CACHE when you want to force old cached files to be cleared.

const CACHE = "pocketvault-v3";
const CORE = [
  "./",
  "./index.html",
  "./bills.html",
  "./investments.html",
  "./holidays.html",
  "./auth-guard.js",
  "./app.css",
  "./app.js",
  "./home.js",
  "./bills.js",
  "./investments.js",
  "./holidays.js",
  "./manifest.json",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png"
];

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
  if (url.origin !== self.location.origin) return;           // Firebase, fonts: leave alone
  if (!url.pathname.startsWith(new URL("./", self.location).pathname)) return; // other repos on this domain

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./index.html")))
  );
});
