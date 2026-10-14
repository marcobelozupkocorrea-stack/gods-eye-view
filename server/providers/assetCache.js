/**
 * barreto.top: long-lived browser caching for Vite's content-hashed bundle.
 *
 * Files under /assets/ carry a content hash in their name, so a new build
 * always produces new URLs. Marking them immutable lets browsers skip the
 * revalidation round trip on every visit. Only successful responses get the
 * header — an auth redirect or an error must never be cached.
 */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

export function isHashedAssetPath(url) {
  const path = String(url || '').split('?')[0];
  return /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(path);
}

export function assetCacheHeaders() {
  const install = (server) => {
    server.middlewares.use((req, res, next) => {
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        isHashedAssetPath(req.url)
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
            res.setHeader('Cache-Control', IMMUTABLE_CACHE);
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
    configureServer: install,
    configurePreviewServer: install,
  };
}
