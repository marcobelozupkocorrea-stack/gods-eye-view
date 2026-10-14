/**
 * barreto.top: place search and "where am I looking" for Brazil.
 *
 *   GET /api/br/search?q=avenida paulista 1000[&lat=&lon=]
 *     → { results: [{ name, detail, kind, lat, lon, bbox }] }
 *     Photon (OpenStreetMap) restricted to Brazil first, then worldwide; a
 *     CEP ("01310-100") is resolved through BrasilAPI to its street first.
 *   GET /api/br/reverse?lat=&lon=&level=bairro|cidade|estado[&polygon=1]
 *     → { level, name, bairro, cidade, uf, estado, pais, label, bbox, polygon }
 *     Nominatim reverse in Portuguese; `polygon=1` adds the area's outline
 *     (simplified GeoJSON) so the map can draw its limits.
 *
 *   GET|PUT /api/br/favorites → { favorites: [{ name, lat, lon, detail }] }
 *     Saved places of the signed-in person (e-mail from oauth2-proxy via
 *     Caddy's X-Auth-Request-Email), kept in /app/data/favorites so they
 *     follow the person between phone and computer and survive deploys.
 *
 * Nominatim allows one request per second: calls queue behind a shared gate
 * and every answer is cached (reverse by ~1 km cell).
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readResponseTextCapped } from './common/http.js';

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const BRASILAPI_CEP = 'https://brasilapi.com.br/api/cep/v2/';
const UA = 'barreto.top/1.0 (+https://barreto.top)';
const BRAZIL_BBOX = '-74.1,-33.9,-34.7,5.4';
const SEARCH_TTL_MS = 30 * 60_000;
const REVERSE_TTL_MS = 24 * 3600_000;
const NOMINATIM_GAP_MS = 1100;
const LEVEL_ZOOM = Object.freeze({ bairro: 14, cidade: 10, estado: 5 });

const UF = Object.freeze({
  Acre: 'AC',
  Alagoas: 'AL',
  Amapá: 'AP',
  Amazonas: 'AM',
  Bahia: 'BA',
  Ceará: 'CE',
  'Distrito Federal': 'DF',
  'Espírito Santo': 'ES',
  Goiás: 'GO',
  Maranhão: 'MA',
  'Mato Grosso': 'MT',
  'Mato Grosso do Sul': 'MS',
  'Minas Gerais': 'MG',
  Pará: 'PA',
  Paraíba: 'PB',
  Paraná: 'PR',
  Pernambuco: 'PE',
  Piauí: 'PI',
  'Rio de Janeiro': 'RJ',
  'Rio Grande do Norte': 'RN',
  'Rio Grande do Sul': 'RS',
  Rondônia: 'RO',
  Roraima: 'RR',
  'Santa Catarina': 'SC',
  'São Paulo': 'SP',
  Sergipe: 'SE',
  Tocantins: 'TO',
});
export const ufOf = (state) => UF[state] || null;

const KIND_PT = Object.freeze({
  house: 'Endereço',
  street: 'Rua',
  locality: 'Localidade',
  district: 'Bairro',
  city: 'Cidade',
  county: 'Município',
  state: 'Estado',
  country: 'País',
  other: 'Lugar',
});

function boundedCache(max = 500) {
  const map = new Map();
  return {
    get(key, ttl) {
      const hit = map.get(key);
      if (!hit || Date.now() - hit.at > ttl) return null;
      map.delete(key);
      map.set(key, hit);
      return hit.value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, { at: Date.now(), value });
      while (map.size > max) map.delete(map.keys().next().value);
    },
  };
}

/** One Photon feature → a search result for the page. */
export function photonResult(feature) {
  const p = feature?.properties || {};
  const [lon, lat] = feature?.geometry?.coordinates || [];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const street = p.street
    ? `${p.street}${p.housenumber ? `, ${p.housenumber}` : ''}`
    : '';
  const name =
    p.name ||
    street ||
    p.district ||
    p.city ||
    p.state ||
    p.country ||
    'Lugar sem nome';
  const uf = ufOf(p.state);
  const place = [
    p.name && street ? street : '',
    p.district && p.district !== name ? p.district : '',
    p.city && p.city !== name ? p.city : '',
    uf || (p.state && p.state !== name ? p.state : ''),
    p.countrycode && p.countrycode !== 'BR' ? p.country : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const kind = KIND_PT[p.type] || KIND_PT.other;
  const ext = Array.isArray(p.extent) ? p.extent.map(Number) : null;
  const bbox =
    ext && ext.length === 4 && ext.every(Number.isFinite)
      ? [
          Math.min(ext[0], ext[2]),
          Math.min(ext[1], ext[3]),
          Math.max(ext[0], ext[2]),
          Math.max(ext[1], ext[3]),
        ]
      : null;
  return {
    name,
    detail: place,
    kind,
    type: p.type || 'other',
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    bbox,
    country: p.countrycode || null,
  };
}

/** Nominatim reverse JSON → the "where am I looking" record. */
export function reverseRecord(json, level) {
  const a = json?.address || {};
  const cidade =
    a.city || a.town || a.village || a.municipality || a.county || null;
  const bairro =
    a.suburb || a.neighbourhood || a.quarter || a.city_district || null;
  const estado = a.state || null;
  const uf =
    (typeof a['ISO3166-2-lvl4'] === 'string' &&
      a['ISO3166-2-lvl4'].startsWith('BR-') &&
      a['ISO3166-2-lvl4'].slice(3)) ||
    ufOf(estado);
  const pais = a.country || null;
  const label =
    level === 'estado'
      ? [estado, pais].filter(Boolean).join(' · ')
      : level === 'cidade'
        ? [cidade, uf || estado].filter(Boolean).join(' – ')
        : [bairro, [cidade, uf].filter(Boolean).join(' – ')]
            .filter(Boolean)
            .join(' · ');
  const bb = Array.isArray(json?.boundingbox)
    ? json.boundingbox.map(Number)
    : null;
  const geo = json?.geojson;
  const polygon =
    geo && (geo.type === 'Polygon' || geo.type === 'MultiPolygon') ? geo : null;
  return {
    level,
    name:
      json?.name ||
      (level === 'estado' ? estado : level === 'cidade' ? cidade : bairro) ||
      null,
    bairro,
    cidade,
    uf: uf || null,
    estado,
    pais,
    label: label || json?.display_name || null,
    // Nominatim bbox order: [south, north, west, east].
    bbox:
      bb && bb.length === 4 && bb.every(Number.isFinite)
        ? [bb[2], bb[0], bb[3], bb[1]]
        : null,
    polygon,
  };
}

/** Persistent data folder: /app/data next to /app/releases, else a cache. */
export function barretoDataDir(cwd = process.cwd()) {
  if (process.env.BARRETO_DATA_DIR) return process.env.BARRETO_DATA_DIR;
  const m = /^(.*)\/releases\/[^/]+\/?$/.exec(cwd);
  return m ? path.join(m[1], 'data') : path.join(cwd, '.gev-cache', 'barreto');
}

/** Keep only well-formed favourites (max 30). */
export function cleanFavorites(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const f of list) {
    const lat = Number(f?.lat);
    const lon = Number(f?.lon);
    const name = typeof f?.name === 'string' ? f.name.trim().slice(0, 40) : '';
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    out.push({
      name,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      detail: typeof f.detail === 'string' ? f.detail.slice(0, 120) : '',
    });
    if (out.length >= 30) break;
  }
  return out;
}

export function barretoPlacesProxy({
  fetchImpl = fetch,
  dataDir = barretoDataDir(),
} = {}) {
  const searches = boundedCache(400);
  const reverses = boundedCache(2000);
  const inflight = new Map();
  let nextSlot = 0;

  async function getText(url, { gate = false, timeoutMs = 10_000 } = {}) {
    if (gate) {
      const now = Date.now();
      const slot = Math.max(now, nextSlot);
      nextSlot = slot + NOMINATIM_GAP_MS;
      if (slot - now > 8_000) throw new Error('busy');
      if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          'Accept-Language': 'pt-BR,pt;q=0.9',
        },
      });
      if (!res.ok) {
        try {
          await res.body?.cancel();
        } catch {
          /* closed */
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return await readResponseTextCapped(res, 4 * 1024 * 1024);
    } finally {
      clearTimeout(timer);
    }
  }

  const once = (key, work) => {
    if (inflight.has(key)) return inflight.get(key);
    const p = work().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  async function photon(q, { bbox, lat, lon, limit = 8 }) {
    const u = new URL(PHOTON);
    u.searchParams.set('q', q);
    u.searchParams.set('limit', String(limit));
    if (bbox) u.searchParams.set('bbox', bbox);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      u.searchParams.set('lat', lat.toFixed(3));
      u.searchParams.set('lon', lon.toFixed(3));
    }
    const json = JSON.parse(await getText(u.href));
    return (json.features || []).map(photonResult).filter(Boolean);
  }

  async function search(q, lat, lon) {
    const cep = /^(\d{5})-?(\d{3})$/.exec(q.replace(/\s/g, ''));
    let query = q;
    let cepInfo = null;
    if (cep) {
      try {
        const info = JSON.parse(
          await getText(`${BRASILAPI_CEP}${cep[1]}${cep[2]}`, {
            timeoutMs: 6000,
          }),
        );
        cepInfo = info;
        query = [info.street, info.neighborhood, info.city, info.state]
          .filter(Boolean)
          .join(', ');
      } catch {
        return [];
      }
    }
    let results = await photon(query, { bbox: BRAZIL_BBOX, lat, lon });
    if (!results.length && !cep)
      results = await photon(query, { lat, lon, limit: 6 });
    if (cepInfo && results.length) {
      // A CEP names a street: put the street itself first.
      const rank = (r) =>
        r.type === 'street' ? 0 : r.type === 'house' ? 2 : 1;
      results = [...results]
        .sort((x, y) => rank(x) - rank(y))
        .slice(0, 3)
        .map((r, i) => ({
          ...r,
          kind: 'CEP',
          name: i === 0 && cepInfo.street ? cepInfo.street : r.name,
          detail: [
            i === 0
              ? [cepInfo.neighborhood, cepInfo.city, cepInfo.state]
                  .filter(Boolean)
                  .join(' · ')
              : r.detail,
            `CEP ${cep[1]}-${cep[2]}`,
          ]
            .filter(Boolean)
            .join(' · '),
        }));
    }
    // Same place returned twice (node + way) → keep the first.
    const seen = new Set();
    return results.filter((r) => {
      const key = `${r.name}|${r.detail}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function json(res, status, body, cache = 'private, max-age=60') {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cache,
    });
    res.end(JSON.stringify(body));
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/search') {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 160);
        if (q.length < 2) return json(res, 200, { results: [] });
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        const key = `${q.toLowerCase()}|${Number.isFinite(lat) ? lat.toFixed(1) : ''}|${Number.isFinite(lon) ? lon.toFixed(1) : ''}`;
        let results = searches.get(key, SEARCH_TTL_MS);
        if (!results) {
          results = await once(`s:${key}`, () =>
            search(
              q,
              Number.isFinite(lat) ? lat : undefined,
              Number.isFinite(lon) ? lon : undefined,
            ),
          );
          searches.set(key, results);
        }
        return json(res, 200, { results });
      }
      if (url.pathname === '/favorites') {
        const email = String(req.headers?.['x-auth-request-email'] || 'local')
          .trim()
          .toLowerCase();
        const file = path.join(
          dataDir,
          'favorites',
          `${createHash('sha256').update(email).digest('hex').slice(0, 32)}.json`,
        );
        if (req.method === 'PUT' || req.method === 'POST') {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 32_768)
              return json(res, 413, { error: 'too_large' }, 'no-store');
          }
          let favorites;
          try {
            favorites = cleanFavorites(JSON.parse(body)?.favorites);
          } catch {
            return json(res, 400, { error: 'invalid_json' }, 'no-store');
          }
          await fsp.mkdir(path.dirname(file), { recursive: true });
          await fsp.writeFile(file, JSON.stringify({ favorites }), 'utf8');
          return json(res, 200, { favorites }, 'no-store');
        }
        let favorites = [];
        try {
          favorites = cleanFavorites(
            JSON.parse(await fsp.readFile(file, 'utf8')).favorites,
          );
        } catch {
          /* none saved yet */
        }
        return json(res, 200, { favorites }, 'no-store');
      }
      if (url.pathname === '/reverse') {
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        const level = Object.hasOwn(LEVEL_ZOOM, url.searchParams.get('level'))
          ? url.searchParams.get('level')
          : 'bairro';
        const polygon = url.searchParams.get('polygon') === '1';
        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lon) ||
          Math.abs(lat) > 90 ||
          Math.abs(lon) > 180
        )
          return json(res, 400, { error: 'invalid_point' });
        // ~1 km cells for a bairro, ~5 km for a city, ~50 km for a state.
        const step =
          level === 'bairro' ? 0.01 : level === 'cidade' ? 0.05 : 0.5;
        const cell = `${Math.round(lat / step)}|${Math.round(lon / step)}`;
        const key = `${level}|${cell}|${polygon ? 'p' : ''}`;
        let record = reverses.get(key, REVERSE_TTL_MS);
        if (!record) {
          record = await once(`r:${key}`, async () => {
            const u = new URL(NOMINATIM);
            u.searchParams.set('lat', lat.toFixed(5));
            u.searchParams.set('lon', lon.toFixed(5));
            u.searchParams.set('format', 'jsonv2');
            u.searchParams.set('zoom', String(LEVEL_ZOOM[level]));
            u.searchParams.set('addressdetails', '1');
            u.searchParams.set('accept-language', 'pt-BR');
            if (polygon) {
              u.searchParams.set('polygon_geojson', '1');
              u.searchParams.set(
                'polygon_threshold',
                level === 'estado'
                  ? '0.01'
                  : level === 'cidade'
                    ? '0.002'
                    : '0.0005',
              );
            }
            return reverseRecord(
              JSON.parse(await getText(u.href, { gate: true })),
              level,
            );
          });
          reverses.set(key, record);
        }
        return json(res, 200, record, 'private, max-age=3600');
      }
      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      console.warn('[br-places]', error?.message || error);
      if (!res.headersSent)
        json(
          res,
          error?.message === 'busy' ? 429 : 502,
          { error: 'place_lookup_unavailable' },
          'no-store',
        );
    }
  }

  const install = ({ middlewares }) => {
    middlewares.use('/api/br', handler);
  };
  return {
    name: 'barreto-places',
    configureServer: install,
    configurePreviewServer: install,
  };
}
