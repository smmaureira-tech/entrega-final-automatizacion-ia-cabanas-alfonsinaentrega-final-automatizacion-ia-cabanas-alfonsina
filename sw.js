/* Service worker: funcionamiento sin conexión y recordatorios con la app cerrada (Android). */
importScripts('core.js');

const CACHE = 'mis-pagos-v1';
const ASSETS = ['./', 'index.html', 'app.js', 'core.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Responde desde la caché y actualiza en segundo plano.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then(r => {
      if (r.ok) cache.put(req, r.clone());
      return r;
    }).catch(() => cached);
    return cached || network;
  }));
});

async function checkReminders() {
  const state = await PagosCore.idbGet('state');
  if (!state || !state.settings || !state.settings.notify) return;
  await PagosCore.notifyDue(self.registration, state);
}

self.addEventListener('periodicsync', e => {
  if (e.tag === 'recordatorios') e.waitUntil(checkReminders());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
});
