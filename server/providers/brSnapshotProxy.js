/**
 * barreto.top: tiny same-origin snapshot proxy shared by the Brazilian
 * point layers (DETER, Cemaden). One upstream refresh at a time, served from
 * cache within the TTL, stale on upstream failure, JSON `{fetchedAt, stale,
 * rows}` like the alert proxies.
 */
export function brSnapshotProxy({
  name,
  path,
  ttlMs,
  refresh,
  now = () => Date.now(),
}) {
  let snapshot = null;
  let inflight = null;

  const load = () => {
    if (!inflight) {
      inflight = Promise.resolve()
        .then(refresh)
        .then((rows) => {
          snapshot = { at: now(), rows };
          return snapshot;
        })
        .catch((err) => {
          console.warn(`[${name}] refresh failed:`, err?.message || err);
          return null;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };

  const installMiddleware = (server) => {
    server.middlewares.use(path, async (req, res) => {
      const send = (status, body) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(body));
      };
      if (req.method && req.method !== 'GET') {
        send(405, { error: 'method_not_allowed' });
        return;
      }
      try {
        if (snapshot) {
          // Stale-while-revalidate: answer at once, refresh in the background.
          const expired = now() - snapshot.at >= ttlMs;
          if (expired) void load();
          send(200, {
            fetchedAt: snapshot.at,
            stale: expired,
            rows: snapshot.rows,
          });
          return;
        }
        const fresh = await load();
        const entry = fresh || snapshot;
        if (!entry) {
          send(502, { error: `${name}_unavailable` });
          return;
        }
        send(200, { fetchedAt: entry.at, stale: !fresh, rows: entry.rows });
      } catch (err) {
        console.warn(`[${name}] error:`, err?.message || err);
        send(500, { error: `${name}_proxy_error` });
      }
    });
  };

  return {
    name: `${name}-proxy`,
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
