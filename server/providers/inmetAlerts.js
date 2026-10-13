import {
  isCurrentWarning,
  parseInmetCap,
  parseInmetRssIds,
} from '../../src/data/inmetCap.js';
import { readResponseTextCapped } from './common/http.js';

const RSS_URL = 'https://apiprevmet3.inmet.gov.br/avisos/rss';
const CAP_URL = (id) =>
  `https://apiprevmet3.inmet.gov.br/avisos/rss/${encodeURIComponent(id)}`;
const MIB = 1024 * 1024;
const TTL_MS = 10 * 60_000;
const MAX_WARNINGS = 300;
const CONCURRENCY = 4;

/**
 * Same-origin proxy for INMET weather warnings (Brazil).
 * GET /api/inmet/alerts → { fetchedAt, stale, rows: [...] }
 *
 * The RSS list is refreshed every 10 minutes; each CAP document is fetched
 * once per warning id and cached, because INMET issues a new id (rather than
 * editing in place) whenever a warning changes.
 */
export function inmetAlertsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** id → parsed row (or null for cancellations / undrawable warnings). */
  const capCache = new Map();
  let snapshot = null;
  let inflight = null;

  async function fetchText(url, cap, timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, { signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    return readResponseTextCapped(response, cap, signal);
  }

  async function loadCap(id) {
    if (capCache.has(id)) return capCache.get(id);
    try {
      const row = parseInmetCap(
        await fetchText(CAP_URL(id), 2 * MIB, 20_000),
        id,
      );
      capCache.set(id, row);
      return row;
    } catch (err) {
      console.warn(`[inmet-alerts] warning ${id} failed:`, err?.message || err);
      return null; // not cached: retried on the next refresh
    }
  }

  async function refresh() {
    const ids = parseInmetRssIds(
      await fetchText(RSS_URL, 8 * MIB, 30_000),
    ).slice(0, MAX_WARNINGS);
    const rows = [];
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = await Promise.all(
        ids.slice(i, i + CONCURRENCY).map(loadCap),
      );
      for (const row of batch) if (row) rows.push(row);
    }
    // Drop cached ids INMET no longer lists so the cache stays bounded.
    const listed = new Set(ids);
    for (const id of capCache.keys()) if (!listed.has(id)) capCache.delete(id);
    const at = now();
    return {
      at,
      rows: rows
        .filter((row) => isCurrentWarning(row, at))
        .sort(
          (a, b) =>
            b.severityRank - a.severityRank || (a.onset ?? 0) - (b.onset ?? 0),
        ),
    };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/inmet/alerts', async (req, res) => {
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
        if (snapshot && now() - snapshot.at < TTL_MS) {
          send(200, {
            fetchedAt: snapshot.at,
            stale: false,
            rows: snapshot.rows.filter((row) => isCurrentWarning(row, now())),
          });
          return;
        }
        if (!inflight) {
          inflight = refresh()
            .then((fresh) => {
              snapshot = fresh;
              return fresh;
            })
            .catch((err) => {
              console.warn(
                '[inmet-alerts] refresh failed:',
                err?.message || err,
              );
              return null;
            })
            .finally(() => {
              inflight = null;
            });
        }
        const fresh = await inflight;
        const entry = fresh || snapshot;
        if (!entry) {
          send(502, { error: 'inmet_unavailable' });
          return;
        }
        send(200, {
          fetchedAt: entry.at,
          stale: !fresh,
          rows: entry.rows.filter((row) => isCurrentWarning(row, now())),
        });
      } catch (err) {
        console.warn('[inmet-alerts] error:', err?.message || err);
        send(500, { error: 'inmet_proxy_error' });
      }
    });
  };

  return {
    name: 'inmet-alerts-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
