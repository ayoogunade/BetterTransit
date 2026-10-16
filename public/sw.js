// Offline fallback: last-good app files and API responses (network is always tried first).
const SHELL = 'shell-v6';
const FILES = ['/', '/app.js', '/icons-data.js', '/style.css', '/manifest.json', '/favicon.svg'];
// a redirected response is the login page standing in for a signed-out request: never cache it as the app
const good = (r) => r.ok && !r.redirected;
const put = (store, req, r) => { if (good(r)) { const copy = r.clone(); caches.open(store).then((c) => c.put(req, copy)); } return r; };
self.addEventListener('install', (e) => e.waitUntil(Promise.all(FILES.map((f) => fetch(f).then((r) => put(SHELL, f, r)).catch(() => {}))).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Page loads go straight to the network while online. A service worker can't show the browser's sign-in prompt, so proxying a 401 left a blank page after signing in.
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
