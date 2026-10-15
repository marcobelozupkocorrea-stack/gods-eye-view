/**
 * barreto.top: Brazilian weather radars (CPTEC/INPE nowcasting catalogue).
 *
 *   GET /api/brazil-radar/manifest
 *     → { schemaVersion, fetchedAt, radars: [{ id, name, owner, bounds, time, stamp }] }
 *   GET /api/brazil-radar/frame?id=decea/saoroque/cappi/cappi3km&stamp=202610141600
 *     → the radar's CAPPI 3 km reflectivity PNG (transparent where no echo).
 *
 * Only radars from CPTEC's own catalogue, with a frame from the last 90
 * minutes, are offered; frame URLs come from that catalogue, never from the
 * client. CPTEC images carry no CORS headers, so the browser gets them here.
 */
import { readResponseTextCapped } from './common/http.js';
import { readWindBody as readBytesCapped } from '../../src/sources/windBody.js';

const CATALOG_URL = 'https://nowcasting.cptec.inpe.br/api/v1/paths/catalog';
const FRAME_PREFIX = 'https://s0.cptec.inpe.br/radar/geoserver/';
const CATALOG_TTL_MS = 4 * 60_000;
const FRESH_MS = 90 * 60_000;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_BYTES = 3 * 1024 * 1024;
const MAX_FRAMES = 96;
const KEY_RE = /^[a-z]{2,16}\/[a-z]{2,32}\/cappi\/cappi3km$/;
/** 1×1 transparent PNG. */
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==',
  'base64',
);
const STAMP_RE = /^20\d{10}$/;

const OWNER_NAMES = Object.freeze({
  DECEA: 'DECEA (Força Aérea)',
  CEMADEN: 'Cemaden',
  SIPAM: 'SIPAM',
  SDCSC: 'Defesa Civil SC',
  INEA: 'INEA (RJ)',
  FUNCEME: 'FUNCEME (CE)',
  APAC: 'APAC (PE)',
});

/** "2026-10-14T16:00:00Z" → "202610141600" (CPTEC's frame file stamp). */
export function radarStamp(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00(?:\.000)?Z$/.exec(
    String(iso || ''),
  );
  return m ? m.slice(1).join('') : null;
}

const prettyName = (value) =>
  String(value || '')
    .replace(/-/g, ' ')
    .replace(/\b(Da|De|Do|Dos|Das)\b/g, (w) => w.toLowerCase())
    .replace(/^./, (c) => c.toUpperCase())
    .replace('São Luiz', 'São Luís')
    .replace('Boavista', 'Boa Vista')
    .replace('Santa Tereza', 'Santa Teresa');

/** Live CAPPI 3 km reflectivity radars from CPTEC's catalogue JSON. */
export function parseRadarCatalog(json, nowMs = Date.now()) {
  const sources = Array.isArray(json?.sources) ? json.sources : [];
  const radar = sources.find((s) => s?.slug === 'radar');
  const products = Array.isArray(radar?.products) ? radar.products : [];
  const radars = [];
  const seen = new Set();
  for (const p of products) {
    const key = typeof p?.key === 'string' ? p.key : '';
    if (!KEY_RE.test(key) || seen.has(key)) continue;
    const url =
      typeof p.direct_frame_url === 'string' ? p.direct_frame_url : '';
    if (
      !url.startsWith(FRAME_PREFIX) ||
      !url.endsWith('_{stamp}.png') ||
      url.split('{stamp}').length !== 2 ||
      /[?#\s]/.test(url)
    )
      continue;
    const stamp = radarStamp(p.latest_time);
    const time = Date.parse(p.latest_time);
    if (!stamp || !Number.isFinite(time)) continue;
    if (nowMs - time > FRESH_MS || time - nowMs > 5 * 60_000) continue;
    const b = p.bounds;
    const south = Number(b?.[0]?.[0]);
    const west = Number(b?.[0]?.[1]);
    const north = Number(b?.[1]?.[0]);
    const east = Number(b?.[1]?.[1]);
    if (
      ![south, west, north, east].every(Number.isFinite) ||
      west < -80 ||
      east > -25 ||
      south < -40 ||
      north > 10 ||
      west >= east ||
      south >= north ||
      east - west > 12 ||
      north - south > 12
    )
      continue;
    const groups = Array.isArray(p.groups) ? p.groups.map(String) : [];
    seen.add(key);
    radars.push({
      id: key,
      name: prettyName(groups[1] || key.split('/')[1]),
      owner: OWNER_NAMES[groups[0]] || groups[0] || null,
      bounds: { west, south, east, north },
      time: new Date(time).toISOString(),
      stamp,
      frameUrl: url,
    });
  }
  radars.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return radars;
}

export function brazilRadarProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 15_000,
} = {}) {
  let catalog = null; // { at, radars }
  let catalogPending = null;
  let lastFailure = 0;
  const frames = new Map();
  const framePending = new Map();

  /** Fetch with one timeout covering headers and body; call done() after. */
  async function upstream(url, accept) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const done = () => clearTimeout(timer);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: { Accept: accept, 'User-Agent': 'barreto.top' },
      });
      return { response, signal: controller.signal, done };
    } catch (error) {
      done();
      throw error;
    }
  }

  async function loadCatalog() {
    if (catalog && now() - catalog.at < CATALOG_TTL_MS) return catalog;
    if (catalogPending) return catalogPending;
    if (now() - lastFailure < 30_000) {
      if (catalog) return catalog;
      throw new Error('radar_catalog_unavailable');
    }
    catalogPending = (async () => {
      try {
        const { response, signal, done } = await upstream(
          CATALOG_URL,
          'application/json',
        );
        let text;
        try {
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`HTTP ${response.status}`);
          }
          text = await readResponseTextCapped(
            response,
            MAX_CATALOG_BYTES,
            signal,
          );
        } finally {
          done();
        }
        const radars = parseRadarCatalog(JSON.parse(text), now());
        catalog = { at: now(), radars };
        return catalog;
      } catch (error) {
        lastFailure = now();
        if (catalog) return catalog;
        throw error;
      } finally {
        catalogPending = null;
      }
    })();
    return catalogPending;
  }

  async function loadFrame(radar, stamp) {
    const key = `${radar.id}@${stamp}`;
    const hit = frames.get(key);
    if (hit) {
      frames.delete(key);
      frames.set(key, hit);
      return hit;
    }
    if (framePending.has(key)) return framePending.get(key);
    const work = (async () => {
      const { response, signal, done } = await upstream(
        radar.frameUrl.replace('{stamp}', stamp),
        'image/png',
      );
      let bytes;
      try {
        if (
          !response.ok ||
          !/^image\/png(?:;|$)/i.test(
            response.headers.get('content-type') || '',
          )
        ) {
          await response.body?.cancel();
          throw new Error(`HTTP ${response.status}`);
        }
        bytes = await readBytesCapped(response, MAX_FRAME_BYTES, signal);
      } finally {
        done();
      }
      const buffer = Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      if (
        !buffer
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new Error('not_png');
      frames.set(key, buffer);
      while (frames.size > MAX_FRAMES)
        frames.delete(frames.keys().next().value);
      return buffer;
    })().finally(() => framePending.delete(key));
    framePending.set(key, work);
    return work;
  }

  /**
   * Timeline frames: radars publish every 5–12 minutes, so the requested
   * minute may not exist. Look back up to 11 minutes; with nothing there,
   * answer a transparent pixel so the map shows "no data" instead of a
   * white square.
   */
  const missing = new Map();
  async function loadPastFrame(radar, stamp) {
    const key = `${radar.id}@${stamp}`;
    if (missing.has(key)) return TRANSPARENT_PNG;
    const base = Date.UTC(
      Number(stamp.slice(0, 4)),
      Number(stamp.slice(4, 6)) - 1,
      Number(stamp.slice(6, 8)),
      Number(stamp.slice(8, 10)),
      Number(stamp.slice(10, 12)),
    );
    for (let back = 0; back <= 11; back += 1) {
      const d = new Date(base - back * 60_000);
      const s = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
      if (missing.has(`${radar.id}@${s}`)) continue;
      try {
        return await loadFrame(radar, s);
      } catch {
        missing.set(`${radar.id}@${s}`, true);
      }
    }
    missing.set(key, true);
    while (missing.size > 4000) missing.delete(missing.keys().next().value);
    return TRANSPARENT_PNG;
  }

  function json(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  async function handler(req, res) {
    try {
      if (req.method !== 'GET')
        return json(res, 405, { error: 'method_not_allowed' });
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/manifest') {
        const value = await loadCatalog();
        return json(res, 200, {
          schemaVersion: 1,
          source: 'CPTEC/INPE',
          fetchedAt: new Date(value.at).toISOString(),
          stale: now() - value.at > CATALOG_TTL_MS * 2,
          radars: value.radars.map(({ frameUrl, ...radar }) => radar),
        });
      }
      if (url.pathname === '/frame') {
        const id = url.searchParams.get('id') || '';
        const stamp = url.searchParams.get('stamp') || '';
        if (!KEY_RE.test(id) || !STAMP_RE.test(stamp))
          return json(res, 400, { error: 'invalid_radar_frame' });
        const value = await loadCatalog();
        const radar = value.radars.find((r) => r.id === id);
        if (!radar) return json(res, 404, { error: 'unknown_radar' });
        const bytes =
          stamp === radar.stamp
            ? await loadFrame(radar, stamp)
            : await loadPastFrame(radar, stamp);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control':
            bytes === TRANSPARENT_PNG
              ? 'public, max-age=600'
              : 'public, max-age=86400, immutable',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(bytes);
      }
      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      console.warn('[brazil-radar]', error?.message || error);
      if (!res.headersSent)
        json(res, 503, { error: 'radar_upstream_unavailable' });
    }
  }

  const install = ({ middlewares }) => {
    middlewares.use('/api/brazil-radar', handler);
  };
  return {
    name: 'barreto-brazil-radar',
    configureServer: install,
    configurePreviewServer: install,
  };
}
