/* barreto.top service worker.
 *
 * Caches only files that never change under the same name (the app's hashed
 * /assets/ bundles) and the Cesium engine files, plus a small "sem conexão"
 * page. Pages and /api/ data always go to the network, so the passkey login
 * and live data are never served from an old copy. */
const ASSETS = 'barreto-assets-v1';
const ENGINE = 'barreto-engine-v1';
const OFFLINE = 'barreto-offline-v1';
const FONTS = 'barreto-fonts-v1';
const KEEP = [ASSETS, ENGINE, OFFLINE, FONTS];
const OFFLINE_URL = '/offline.html';
const OFFLINE_ICON = '/icons/icon-192.png';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch(OFFLINE_URL, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (cacheable(res, { html: true }))
          await (await caches.open(OFFLINE)).put(OFFLINE_URL, res);
        const icon = await fetch(OFFLINE_ICON, { credentials: 'same-origin' });
        if (cacheable(icon))
          await (await caches.open(OFFLINE)).put(OFFLINE_ICON, icon);
      } catch {
        /* next install */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('barreto-') && !KEEP.includes(key))
          await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

function cacheable(res, { html = false, cross = false } = {}) {
  if (cross)
    return !!res && (res.type === 'opaque' || (res.ok && res.type === 'cors'));
  if (!res || !res.ok || res.redirected || res.type !== 'basic') return false;
  // The server answers a missing /assets/ file with the app page: never keep
  // that under a script's name.
  const type = res.headers.get('content-type') || '';
  return html || !/text\/html/i.test(type);
}

async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i += 1) await cache.delete(keys[i]);
}

async function cacheFirst(request, name, max, opts) {
  const cache = await caches.open(name);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (cacheable(res, opts)) {
    await cache.put(request, res.clone());
    trim(name, max);
  }
  return res;
}

async function staleWhileRevalidate(event, name, max, opts) {
  const cache = await caches.open(name);
  const hit = await cache.match(event.request);
  const network = fetch(event.request)
    .then(async (res) => {
      if (cacheable(res, opts)) {
        await cache.put(event.request, res.clone());
        trim(name, max);
      }
      return res;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(network);
    return hit;
  }
  return (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // The icon font: without it every button shows its icon's name.
  if (url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(request, FONTS, 30, { cross: true }));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(staleWhileRevalidate(event, FONTS, 30, { cross: true }));
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Network as usual (login redirects included); only a failed network
    // gets the offline page.
    event.respondWith(
      fetch(request).catch(async () => {
        const page = await caches.match(OFFLINE_URL);
        return page || Response.error();
      }),
    );
    return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/oauth2/'))
    return;
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, ASSETS, 160));
    return;
  }
  if (url.pathname === OFFLINE_ICON) {
    event.respondWith(
      caches
        .match(OFFLINE_ICON)
        .then((hit) => hit || fetch(request))
        .catch(() => Response.error()),
    );
    return;
  }
  if (
    url.pathname.startsWith('/cesium/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest'
  ) {
    event.respondWith(staleWhileRevalidate(event, ENGINE, 400));
  }
});

// ---------------------------------------------------------------- alerts
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const extreme = Number(data.rank) >= 3;
  event.waitUntil(
    self.registration.showNotification(data.title || 'ABC World View', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      requireInteraction: extreme,
      vibrate: extreme ? [250, 120, 250, 120, 500] : [150, 80, 150],
      lang: 'pt-BR',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin)
    .href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        client.postMessage({ type: 'barreto:open', url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
