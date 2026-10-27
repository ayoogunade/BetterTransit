// The app's own files are served from the cache (refreshed in the background), so a relaunch paints at once instead of
// waiting on the network. API responses always go to the network; the cache is only their offline fallback.
const SHELL = 'shell-v9';
const FILES = ['/', '/app.js', '/icons-data.js', '/style.css', '/manifest.json', '/favicon.svg', '/vendor/leaflet.js', '/vendor/leaflet.css'];
// a redirected response is the login page standing in for a signed-out request: never cache it as the app
const good = (r) => r.ok && !r.redirected;
const put = (store, req, r) => { if (good(r)) { const copy = r.clone(); caches.open(store).then((c) => c.put(req, copy)); } return r; };
self.addEventListener('install', (e) => e.waitUntil(Promise.all(FILES.map((f) => fetch(f).then((r) => put(SHELL, f, r)).catch(() => {}))).then(() => self.skipWaiting())));
// drop the caches of older versions
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL && k !== 'api').map((k) => caches.delete(k)))).then(() => clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Cache first for the app shell. Signed out, the cached page still loads, its first API call gets a 401 and sends you to /login;
  // a signed-out refresh is a redirect to /login, which is never cached (see good).
  if (FILES.includes(url.pathname)) {
    const fresh = fetch(e.request).then((r) => put(SHELL, url.pathname, r));
    e.waitUntil(fresh.catch(() => {}));
    e.respondWith(caches.match(url.pathname).then((hit) => hit || fresh));
    return;
  }
  // other page loads (the login page) go straight to the network while online
  if (e.request.mode === 'navigate' && navigator.onLine) return;
  const isApi = url.pathname.startsWith('/api/');
  // Network first for everything (always fresh when online); the cache is only the offline fallback.
  const store = isApi ? 'api' : SHELL;
  e.respondWith(fetch(e.request).then((r) => put(store, e.request, r)).catch(() => caches.match(e.request)));
});

self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : { title: 'Bus arriving', body: '' };
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body, icon: '/icon-192.png', badge: '/icon-192.png', tag: d.title }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then((cs) => (cs[0] ? cs[0].focus() : clients.openWindow('/'))));
});
