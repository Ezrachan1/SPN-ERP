/* SPN ERP / SPN OS service worker: installable web app with an offline shell.
   - same-origin pages and assets: network first, cache fallback (so a new deploy
     is picked up on the next load, and the app still opens with no network)
   - third-party libraries and fonts (jsdelivr, cdnjs, Google Fonts): cache first
   - /api/* is never cached (the app keeps its own offline copy of the workspace)
   - notification clicks focus the app and open the right module */
const CACHE = 'spn-erp-shell-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
const THIRD_PARTY = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)$/;

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) return;
    e.respondWith(networkFirst(req));
  } else if (THIRD_PARTY.test(url.hostname)) {
    e.respondWith(cacheFirst(req));
  }
});
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') { const idx = await cache.match('/index.html'); if (idx) return idx; }
    throw e;
  }
}
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const view = (e.notification.data && e.notification.data.view) || 'dashboard';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find((c) => 'focus' in c);
    if (client) { await client.focus(); client.postMessage({ type: 'open-view', view }); }
    else await self.clients.openWindow('/#' + view);
  })());
});
