// Service worker: caches the app shell so it works fully offline after one visit.
// app.js registers this as sw.js?v=<VERSION>, so bumping js/version.js installs a
// fresh worker with a clean cache.
// Other apps may share this origin (the battle apps do), so only caches
// with this app's prefix are ours to clean up.
const CACHE_PREFIX = 'rqm-';
const CACHE_NAME = `${CACHE_PREFIX}${new URL(self.location).searchParams.get('v') ?? 'dev'}`;
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/audio.js',
  './js/recent.js',
  './js/gen.js',
  './js/pitch.js',
  './js/crest.js',
  './js/render.js',
  './js/rng.js',
  './js/sim.js',
  './js/version.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Network first, so an update shows up on the very next load and HTML, CSS and JS
  // never mix versions; the cache is only the offline fallback.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })
        .then((cached) => cached || caches.match('./index.html')))
  );
});
