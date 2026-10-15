/**
 * barreto.top: long-lived browser caching for Vite's content-hashed bundle.
 *
 * Files under /assets/ carry a content hash in their name, so a new build
 * always produces new URLs. Marking them immutable lets browsers skip the
 * revalidation round trip on every visit. Only successful responses get the
 * header — an auth redirect or an error must never be cached.
 */
import fs from 'node:fs';
import path from 'node:path';

export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/** Unhashed but versioned-with-the-app files: Cesium's runtime, icons. */
export const STATIC_CACHE =
  'public, max-age=604800, stale-while-revalidate=86400';

export function isStaticLibraryPath(url) {
  const path = String(url || '').split('?')[0];
  return /^\/(?:cesium|icons)\/[^?#]+\.[a-z0-9]+$/i.test(path);
}

export function isHashedAssetPath(url) {
  const path = String(url || '').split('?')[0];
  return /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(path);
}

const BROTLI_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojsonl': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

/** True when the request accepts Brotli (q=0 means refused). */
export function acceptsBrotli(header) {
  return String(header || '')
    .split(',')
    .some((part) => {
      const [name, ...params] = part.trim().split(';');
      if (name.trim().toLowerCase() !== 'br') return false;
      const q = params.find((x) => x.trim().startsWith('q='));
      return !q || Number(q.trim().slice(2)) > 0;
    });
}

/**
 * barreto.top: the `.br` copy written by scripts/barreto-precompress.mjs for
 * a cacheable file, or null. Paths stay inside the build folder.
 */
export function brotliCopyFor(distDir, url) {
  const pathname = decodeURIComponent(String(url || '').split('?')[0]);
  const type = BROTLI_TYPES[path.extname(pathname).toLowerCase()];
  if (!type || pathname.includes('..') || pathname.includes('\0')) return null;
  const file = path.join(distDir, pathname);
  if (!file.startsWith(`${path.resolve(distDir)}${path.sep}`)) return null;
  try {
    const info = fs.statSync(`${file}.br`);
    return info.isFile() ? { file: `${file}.br`, size: info.size, type } : null;
  } catch {
    return null;
  }
}

export function assetCacheHeaders() {
  const install = (server, { precompressed = false } = {}) => {
    const distDir = precompressed
      ? path.resolve(
          server.config?.root || process.cwd(),
          server.config?.build?.outDir || 'dist',
        )
      : null;
    server.middlewares.use((req, res, next) => {
      const cacheable =
        isHashedAssetPath(req.url) || isStaticLibraryPath(req.url);
      if (
        distDir &&
        cacheable &&
        (req.method === 'GET' || req.method === 'HEAD') &&
        acceptsBrotli(req.headers?.['accept-encoding'])
      ) {
        const copy = brotliCopyFor(distDir, req.url);
        if (copy) {
          res.writeHead(200, {
            'Content-Type': copy.type,
            'Content-Encoding': 'br',
            'Content-Length': String(copy.size),
            Vary: 'Accept-Encoding',
            'Cache-Control': isHashedAssetPath(req.url)
              ? IMMUTABLE_CACHE
              : STATIC_CACHE,
          });
          if (req.method === 'HEAD') return res.end();
          fs.createReadStream(copy.file)
            .on('error', () => res.destroy())
            .pipe(res);
          return;
        }
      }
      const hashed = isHashedAssetPath(req.url);
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        (hashed || isStaticLibraryPath(req.url))
      ) {
        const writeHead = res.writeHead;
        res.writeHead = function patchedWriteHead(status, ...rest) {
          const last = rest[rest.length - 1];
          const headers =
            last && typeof last === 'object' && !Array.isArray(last)
              ? last
              : {};
          const type = String(
            Object.entries(headers).find(
              ([key]) => key.toLowerCase() === 'content-type',
            )?.[1] ??
              res.getHeader?.('content-type') ??
              '',
          );
          // The SPA fallback answers unknown /assets/ URLs with index.html.
          if ((status === 200 || status === 304) && !/text\/html/i.test(type)) {
            for (const key of Object.keys(headers))
              if (key.toLowerCase() === 'cache-control') delete headers[key];
            res.setHeader(
              'Cache-Control',
              hashed ? IMMUTABLE_CACHE : STATIC_CACHE,
            );
          }
          return writeHead.call(this, status, ...rest);
        };
      }
      next();
    });
  };
  return {
    name: 'barreto-asset-cache',
    // The dev server never serves hashed /assets/ files, so this is inert there.
    configureServer: (server) => install(server),
    configurePreviewServer: (server) =>
      install(server, { precompressed: true }),
    // And the engine script must not block the first paint (see below).
    transformIndexHtml: {
      order: 'post',
      handler: (html) => deferCesiumScript(html),
    },
  };
}

/**
 * barreto.top: load the Cesium engine script without blocking the page.
 * vite-plugin-cesium injects a plain <script src="/cesium/Cesium.js"> in the
 * head, which stops the browser from drawing anything until 5 MB arrive.
 * With `defer` it still runs before the app's module script (deferred scripts
 * run in document order), but the loading screen shows at once.
 */
export function deferCesiumScript(html) {
  return String(html).replace(
    /<script src="(\/cesium\/Cesium\.js)"><\/script>/,
    '<script defer src="$1"></script>',
  );
}
