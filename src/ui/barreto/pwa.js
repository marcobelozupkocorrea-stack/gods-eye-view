/**
 * barreto.top: service worker registration for the installed app.
 *
 * The worker (public/sw.js) only caches the app's own versioned files and the
 * Cesium engine files, so a second start is fast and a lost connection shows a
 * Portuguese "sem conexão" page. It never caches pages or /api data, so the
 * login and live data always come from the server.
 */
export function registerServiceWorker({
  navigator: nav = globalThis.navigator,
  location: loc = globalThis.location,
} = {}) {
  const sw = nav?.serviceWorker;
  if (!sw?.register) return null;
  const host = loc?.hostname || '';
  // Dev servers and previews keep working without a worker in the way.
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]')
    return null;
  const start = () => sw.register('/sw.js', { scope: '/' }).catch(() => null);
  if (globalThis.document?.readyState === 'complete') return start();
  return new Promise((resolve) =>
    globalThis.addEventListener?.('load', () => resolve(start()), {
      once: true,
    }),
  );
}
