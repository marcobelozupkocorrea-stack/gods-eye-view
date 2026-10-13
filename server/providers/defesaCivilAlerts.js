import {
  isCurrentWarning,
  parseAtomCapEntries,
  parseCapAlert,
} from '../../src/data/capAlerts.js';
import { readResponseTextCapped } from './common/http.js';

const FEED_URL = 'https://idapfile.mdr.gov.br/idap/api/rss/cap';
const MIB = 1024 * 1024;
const TTL_MS = 10 * 60_000;
/** The national feed is ~20 MB because of municipal-border polygons. */
const FEED_CAP_BYTES = 80 * MIB;
/** Vertices kept per ring; a whole-state outline still reads clearly. */
const RING_BUDGET = 250;

/**
 * Same-origin proxy for Defesa Civil alerts (Brazil), from the national
 * IDAP (Interface de Divulgação de Alertas Públicos) Atom/CAP feed.
 * GET /api/defesacivil/alerts → { fetchedAt, stale, rows: [...] }
 *
 * The feed is fetched at most every 10 minutes and reduced server-side to the
 * alerts still in force, with simplified polygons, so browsers download a
 * small fraction of the upstream payload.
 */
export function defesaCivilAlertsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let snapshot = null;
  let inflight = null;

  async function refresh() {
    const signal = AbortSignal.timeout(90_000);
    const response = await fetchImpl(FEED_URL, {
      signal,
      redirect: 'error',
      headers: { Accept: 'application/atom+xml, application/xml, */*' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const xml = await readResponseTextCapped(response, FEED_CAP_BYTES, signal);
    const at = now();
    const seen = new Set();
    const rows = [];
    for (const { id, xml: alertXml } of parseAtomCapEntries(xml)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = parseCapAlert(alertXml, id, { maxRingVertices: RING_BUDGET });
      if (row && isCurrentWarning(row, at)) rows.push(row);
    }
    rows.sort(
      (a, b) =>
        b.severityRank - a.severityRank || (b.onset ?? 0) - (a.onset ?? 0),
    );
    return { at, rows };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/defesacivil/alerts', async (req, res) => {
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
        const current = (entry) =>
          entry.rows.filter((row) => isCurrentWarning(row, now()));
        if (snapshot && now() - snapshot.at < TTL_MS) {
          send(200, {
            fetchedAt: snapshot.at,
            stale: false,
            rows: current(snapshot),
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
                '[defesa-civil-alerts] refresh failed:',
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
          send(502, { error: 'idap_unavailable' });
          return;
        }
        send(200, {
          fetchedAt: entry.at,
          stale: !fresh,
          rows: current(entry),
        });
      } catch (err) {
        console.warn('[defesa-civil-alerts] error:', err?.message || err);
        send(500, { error: 'defesa_civil_proxy_error' });
      }
    });
  };

  return {
    name: 'defesa-civil-alerts-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
