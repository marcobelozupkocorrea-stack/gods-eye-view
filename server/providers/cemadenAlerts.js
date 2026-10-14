import { parseCemadenAlerts } from '../../src/data/cemaden.js';
import { readResponseTextCapped } from './common/http.js';
import { brSnapshotProxy } from './brSnapshotProxy.js';

export const CEMADEN_ALERTS_URL =
  'https://painelalertas.cemaden.gov.br/wsAlertas2';
const TTL_MS = 5 * 60_000;

/**
 * Same-origin proxy for Cemaden municipal risk alerts (Brazil).
 * GET /api/cemaden/alerts → { fetchedAt, stale, rows: [...] }
 */
export function cemadenAlertsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  return brSnapshotProxy({
    name: 'cemaden-alerts',
    path: '/api/cemaden/alerts',
    ttlMs: TTL_MS,
    now,
    async refresh() {
      const signal = AbortSignal.timeout(30_000);
      const response = await fetchImpl(CEMADEN_ALERTS_URL, {
        signal,
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await readResponseTextCapped(
        response,
        8 * 1024 * 1024,
        signal,
      );
      return parseCemadenAlerts(JSON.parse(text));
    },
  });
}
