import {
  DETER_BIOMES,
  parseDeterFeatures,
  sortDeterRows,
} from '../../src/data/deter.js';
import { readResponseTextCapped } from './common/http.js';
import { brSnapshotProxy } from './brSnapshotProxy.js';

const WFS_URL = 'https://terrabrasilis.dpi.inpe.br/geoserver/ows';
const MIB = 1024 * 1024;
/** DETER is published a few times a week; 3 h keeps it fresh and cheap. */
const TTL_MS = 3 * 60 * 60_000;
const WINDOW_DAYS = 30;
const MAX_ROWS = 8000;

/** GetFeature URL for one biome's alerts seen since `sinceIso` (YYYY-MM-DD). */
export function deterFeatureUrl(typeName, sinceIso) {
  const url = new URL(WFS_URL);
  url.search = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeName,
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
    CQL_FILTER: `view_date>='${sinceIso}'`,
  }).toString();
  return url.href;
}

/**
 * Same-origin proxy for INPE DETER alerts (last 30 days, Amazônia + Cerrado).
 * GET /api/deter/alerts → { fetchedAt, stale, rows: [...] }
 */
export function deterAlertsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  async function fetchBiome(key, sinceIso) {
    const signal = AbortSignal.timeout(120_000);
    const response = await fetchImpl(
      deterFeatureUrl(DETER_BIOMES[key].typeName, sinceIso),
      { signal, redirect: 'error', headers: { Accept: 'application/json' } },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${key} HTTP ${response.status}`);
    }
    const text = await readResponseTextCapped(response, 80 * MIB, signal);
    return parseDeterFeatures(JSON.parse(text), key);
  }

  return brSnapshotProxy({
    name: 'deter-alerts',
    path: '/api/deter/alerts',
    ttlMs: TTL_MS,
    now,
    async refresh() {
      const since = new Date(now() - WINDOW_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const settled = await Promise.allSettled(
        Object.keys(DETER_BIOMES).map((key) => fetchBiome(key, since)),
      );
      const ok = settled.filter((s) => s.status === 'fulfilled');
      if (!ok.length) throw settled[0]?.reason || new Error('DETER failed');
      for (const s of settled)
        if (s.status === 'rejected')
          console.warn('[deter-alerts] biome failed:', s.reason?.message);
      return sortDeterRows(
        ok.flatMap((s) => s.value),
        MAX_ROWS,
      );
    },
  });
}
