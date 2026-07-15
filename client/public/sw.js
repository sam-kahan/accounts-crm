// Minimal service worker for the Greenco Accounts CRM PWA.
// Strategy: network-first, falling back to a runtime cache when offline so the
// app shell keeps working without a connection. Vite fingerprints asset
// filenames, so cached assets never go stale for a given build.
const CACHE = 'greenco-crm-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(['/', '/index.html'])),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // Never cache the API — always go to the network.
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        // Cache a copy of successful same-origin responses for offline use.
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // For navigations, fall back to the cached app shell.
        if (request.mode === 'navigate') return caches.match('/index.html');
        throw new Error('offline and not cached');
      }),
  );
});
