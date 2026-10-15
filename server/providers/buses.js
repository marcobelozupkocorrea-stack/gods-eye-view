/**
 * barreto.top: real city-bus positions from the cities that publish them
 * openly.
 *
 *   GET /api/br/onibus?bbox=w,s,e,n
 *     → { fetchedAt, items:[{id, cidade, linha, lat, lon, vel, dir, em}],
 *         cidades:[{id, nome, status, total, em}], tooWide? }
 *
 * Sources (checked October 2026):
 *   - Rio de Janeiro: SMTR "ITS GPS 2.0" (city buses + BRT), no key.
 *   - Distrito Federal: Semob (the data behind "DF no Ponto"), no key.
 *   - Belo Horizonte: PBH/BHTRANS tempo real (CC-BY), no key; blocks some
 *     foreign IP ranges.
 *   - São Paulo: SPTrans Olho Vivo — only when SPTRANS_TOKEN is set (free
 *     token created by the person at sptrans.com.br/desenvolvedores).
 *
 * A city is fetched only while someone is looking at it, and cached for a
 * minute. Positions older than 10 minutes are dropped (several feeds keep
 * long-parked vehicles).
 */

const CACHE_MS = 60_000;
const TRACK_POINTS = 30;
const TRACK_TTL_MS = 20 * 60_000;
const LINE_CELLS_MAX = 4000;
const LINE_TTL_MS = 6 * 60 * 60_000;
/** ~45 m grid for the approximate route of a line. */
const cellOf = (r) =>
  `${Math.round(r.lon / 0.0004)},${Math.round(r.lat / 0.0004)}`;
/** "474 " / "0.156" / "SP-8000-10" → comparable line code. */
export const normLine = (v) =>
  String(v ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
const MAX_AGE_MS = 10 * 60_000;
const MAX_ITEMS = 6000;
const MAX_SPAN_DEG = 2.5;

const num = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** "YYYY-MM-DD HH:MM:SS" (or "YYYYMMDDHHMMSS") in Brasília time → ms. */
export function brasiliaTime(text) {
  const s = String(text || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h + 3, mi, se);
}

/** Headings come as -317.3, "230,53"… → 0–360. */
const heading = (v) => {
  const n = num(v);
  return n == null ? null : ((n % 360) + 360) % 360;
};

/** Several feeds repeat a vehicle once per report: keep its latest. */
export function latestPerVehicle(records) {
  const latest = new Map();
  for (const r of records) {
    const prev = latest.get(r.id);
    if (!prev || (r.em || 0) > (prev.em || 0)) latest.set(r.id, r);
  }
  return [...latest.values()];
}

const valid = (r) =>
  r &&
  Number.isFinite(r.lat) &&
  Number.isFinite(r.lon) &&
  Math.abs(r.lat) > 0.5 &&
  Math.abs(r.lon) > 0.5;

/** Rio ITS rows → one record per vehicle (the latest of the minute). */
export function parseRio(rows) {
  const latest = new Map();
  for (const row of rows || []) {
    const id = row?.id_veiculo;
    if (!id) continue;
    const em = Date.parse(row.datetime) || null;
    const prev = latest.get(id);
    if (prev && (prev.em || 0) >= (em || 0)) continue;
    latest.set(id, {
      id: `rio:${id}`,
      cidade: 'rio',
      linha: String(row.servico || '').trim() || null,
      modo: row.modo === 'brt' ? 'BRT' : 'Ônibus',
      sentido: row.sentido || null,
      lat: num(row.latitude),
      lon: num(row.longitude),
      vel: num(row.velocidade),
      dir: heading(row.direcao),
      em,
    });
  }
  return [...latest.values()].filter(valid);
}

/** DF Semob: an array of FeatureCollections, one per operator. */
export function parseDf(collections) {
  const out = [];
  for (const fc of Array.isArray(collections) ? collections : []) {
    for (const f of fc?.features || []) {
      const v = f?.properties?.veiculo || {};
      const [lon, lat] = f?.geometry?.coordinates || [];
      if (!v.prefixo) continue;
      out.push({
        id: `df:${v.prefixo}`,
        cidade: 'df',
        linha: String(v.numero || '').trim() || null,
        modo: 'Ônibus',
        sentido: v.sentido ? String(v.sentido).toLowerCase() : null,
        operadora: fc.NomeOperadora || null,
        lat: num(lat),
        lon: num(lon),
        vel: num(f.properties.velocidade),
        dir: heading(f.properties.direcao),
        em: brasiliaTime(f.properties.datalocal),
      });
    }
  }
  return latestPerVehicle(out.filter(valid));
}

/** BH tempo real (param=D). */
export function parseBh(body) {
  const rows = Array.isArray(body) ? body : body?.registros || body?.data || [];
  const out = [];
  for (const r of rows) {
    if (!r?.NV) continue;
    const linha = String(r.NL ?? '').trim();
    out.push({
      id: `bh:${r.NV}`,
      cidade: 'bh',
      linha: linha && linha !== '0' ? linha : null,
      modo: 'Ônibus',
      sentido: null,
      lat: num(r.LT),
      lon: num(r.LG),
      vel: num(r.VL),
      dir: heading(r.DG),
      em: brasiliaTime(r.HR),
    });
  }
  return latestPerVehicle(out.filter(valid));
}

/** SPTrans /Posicao. */
export function parseSp(body) {
  const out = [];
  for (const l of body?.l || []) {
    const linha = l.c || null;
    for (const v of l.vs || []) {
      out.push({
        id: `sp:${v.p}`,
        cidade: 'sp',
        linha,
        destino: l.sl === 1 ? l.lt1 : l.lt0,
        modo: 'Ônibus',
        sentido: null,
        acessivel: Boolean(v.a),
        lat: num(v.py),
        lon: num(v.px),
        vel: null,
        dir: null,
        em: Date.parse(v.ta) || null,
      });
    }
  }
  return out.filter(valid);
}

export const BUS_CITIES = Object.freeze([
  {
    id: 'rio',
    nome: 'Rio de Janeiro',
    fonte: 'SMTR Rio (dados.mobilidade.rio)',
    bbox: [-43.82, -23.09, -43.09, -22.74],
  },
  {
    id: 'df',
    nome: 'Distrito Federal',
    fonte: 'Semob-DF',
    bbox: [-48.3, -16.06, -47.3, -15.49],
  },
  {
    id: 'bh',
    nome: 'Belo Horizonte',
    fonte: 'PBH/BHTRANS (CC-BY)',
    bbox: [-44.07, -20.06, -43.85, -19.77],
  },
  {
    id: 'sp',
    nome: 'São Paulo',
    fonte: 'SPTrans Olho Vivo',
    bbox: [-46.83, -23.99, -46.36, -23.36],
    needsKey: 'SPTRANS_TOKEN',
  },
]);

const intersects = ([w, s, e, n], [W, S, E, N]) =>
  w <= E && e >= W && s <= N && n >= S;

export function createBusSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
} = {}) {
  const cache = new Map(); // city → { at, items, error }
  const pending = new Map();
  let spCookie = null;

  const getJson = async (url, init = {}) => {
    const res = await fetchImpl(url, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers || {}) },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      await res.body?.cancel?.();
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  };

  async function fetchRio() {
    // The current minute fills in over its first seconds: ask for the last
    // complete one.
    const minute = new Date(now() - 60_000);
    minute.setUTCSeconds(0, 0);
    const base = new URL(
      'https://its.mobilidade.rio/v1/geolocalizacao/veiculos',
    );
    base.searchParams.set(
      'minuto_utc',
      minute.toISOString().replace('.000', ''),
    );
    base.searchParams.set('limit', '5000');
    const rows = [];
    let cursor = null;
    for (let page = 0; page < 6; page += 1) {
      const u = new URL(base);
      if (cursor) u.searchParams.set('cursor', cursor);
      const body = await getJson(u.href);
      rows.push(...(Array.isArray(body?.data) ? body.data : []));
      cursor = body?.next_cursor || null;
      if (!cursor || !body?.data?.length) break;
    }
    return parseRio(rows);
  }

  const fetchDf = async () =>
    parseDf(await getJson('https://dados.semob.df.gov.br/posicao'));

  const fetchBh = async () =>
    parseBh(await getJson('https://temporeal.pbh.gov.br/?param=D'));

  async function spLogin(token) {
    const res = await fetchImpl(
      `https://api.olhovivo.sptrans.com.br/v2.1/Login/Autenticar?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Length': '0' },
        signal: AbortSignal.timeout(15_000),
      },
    );
    const ok = res.ok && (await res.text()).trim() === 'true';
    if (!ok) throw new Error('token SPTrans recusado');
    const raw = res.headers.get('set-cookie') || '';
    spCookie = raw
      .split(/,(?=\s*[^;,]+=)/)
      .map((c) => c.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');
  }

  async function fetchSp() {
    const token = env.SPTRANS_TOKEN;
    if (!spCookie) await spLogin(token);
    const get = () =>
      getJson('https://api.olhovivo.sptrans.com.br/v2.1/Posicao', {
        headers: { Cookie: spCookie },
      });
    let body;
    try {
      body = await get();
    } catch {
      await spLogin(token);
      body = await get();
    }
    return parseSp(body);
  }

  const FETCHERS = { rio: fetchRio, df: fetchDf, bh: fetchBh, sp: fetchSp };

  function cityStatus(city) {
    if (city.needsKey && !env[city.needsKey])
      return { status: 'sem_chave', total: 0, em: null };
    const hit = cache.get(city.id);
    if (!hit) return { status: 'parado', total: 0, em: null };
    return {
      status: hit.error ? 'falhou' : 'ok',
      total: hit.items.length,
      em: hit.at,
      erro: hit.error || undefined,
    };
  }

  // Short trail per vehicle (for "Acompanhar") and the cells each line has
  // been seen in (its approximate route, built from real positions).
  const tracks = new Map(); // vehicle id → [[lon, lat, t], …]
  const lineCells = new Map(); // `${city}|${linha}` → Map(cell → [lon, lat, t])

  function record(items) {
    const t = now();
    for (const r of items) {
      const track = tracks.get(r.id) || [];
      const last = track[track.length - 1];
      if (!last || last[0] !== r.lon || last[1] !== r.lat) {
        track.push([r.lon, r.lat, r.em || t]);
        while (track.length > TRACK_POINTS) track.shift();
        tracks.set(r.id, track);
      }
      if (!r.linha) continue;
      const key = `${r.cidade}|${normLine(r.linha)}`;
      let cells = lineCells.get(key);
      if (!cells) lineCells.set(key, (cells = new Map()));
      if (cells.size >= LINE_CELLS_MAX && !cells.has(cellOf(r))) continue;
      cells.set(cellOf(r), [r.lon, r.lat, t]);
    }
    // Forget what went quiet.
    for (const [id, track] of tracks)
      if (t - (track[track.length - 1]?.[2] || 0) > TRACK_TTL_MS)
        tracks.delete(id);
    for (const [key, cells] of lineCells) {
      for (const [cell, p] of cells)
        if (t - p[2] > LINE_TTL_MS) cells.delete(cell);
      if (!cells.size) lineCells.delete(key);
    }
  }

  async function loadCity(city) {
    const hit = cache.get(city.id);
    if (hit && now() - hit.at < CACHE_MS) return hit;
    if (pending.has(city.id)) return pending.get(city.id);
    const work = (async () => {
      try {
        const cutoff = now() - MAX_AGE_MS;
        const items = (await FETCHERS[city.id]()).filter(
          (r) => !r.em || (r.em >= cutoff && r.em <= now() + 5 * 60_000),
        );
        const entry = { at: now(), items, error: null };
        cache.set(city.id, entry);
        record(items);
        return entry;
      } catch (err) {
        console.warn(`[onibus] ${city.id}:`, err?.message || err);
        // Keep the last good positions for a few minutes.
        const stale = hit && now() - hit.at < 5 * 60_000 ? hit.items : [];
        const entry = {
          at: now(),
          items: stale,
          error: String(err?.message || err).slice(0, 80),
        };
        cache.set(city.id, entry);
        return entry;
      }
    })().finally(() => pending.delete(city.id));
    pending.set(city.id, work);
    return work;
  }

  async function inBox(bbox, { linha = '', seguir = '' } = {}) {
    const [w, s, e, n] = bbox;
    const line = normLine(linha);
    const cities = BUS_CITIES.map((c) => ({
      id: c.id,
      nome: c.nome,
      fonte: c.fonte,
      bbox: c.bbox,
    }));
    if (e - w > MAX_SPAN_DEG || n - s > MAX_SPAN_DEG)
      return {
        items: [],
        tooWide: true,
        cidades: cities.map((c) => ({
          ...c,
          ...cityStatus(BUS_CITIES.find((x) => x.id === c.id)),
        })),
      };
    const visible = BUS_CITIES.filter(
      (c) => intersects(bbox, c.bbox) && !(c.needsKey && !env[c.needsKey]),
    );
    const loaded = await Promise.all(visible.map(loadCity));
    const items = [];
    let followed = null;
    for (const entry of loaded)
      for (const r of entry.items) {
        if (seguir && r.id === seguir) followed = r;
        // A line filter shows the whole line in the cities on screen.
        if (line) {
          if (normLine(r.linha) === line) items.push(r);
        } else if (r.lon >= w && r.lon <= e && r.lat >= s && r.lat <= n)
          items.push(r);
      }
    if (followed && !items.includes(followed)) items.push(followed);
    // The most common lines on screen, as suggestions for the line filter.
    const counts = new Map();
    if (!line)
      for (const r of items)
        if (r.linha) counts.set(r.linha, (counts.get(r.linha) || 0) + 1);
    const linhasNaTela = [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([l]) => l);
    let trajeto;
    if (line) {
      trajeto = [];
      for (const c of visible)
        for (const p of lineCells.get(`${c.id}|${line}`)?.values() || [])
          if (trajeto.length < LINE_CELLS_MAX) trajeto.push([p[0], p[1]]);
    }
    return {
      items: items.slice(0, MAX_ITEMS),
      cortado: items.length > MAX_ITEMS || undefined,
      ...(line ? { linha: line, trajeto } : { linhasNaTela }),
      ...(followed
        ? {
            rastro: (tracks.get(followed.id) || []).map(([x, y, t]) => [
              x,
              y,
              t,
            ]),
          }
        : {}),
      cidades: cities.map((c) => ({
        ...c,
        ...cityStatus(BUS_CITIES.find((x) => x.id === c.id)),
      })),
    };
  }

  return {
    inBox,
    cityStatus,
    trackOf: (id) => tracks.get(id)?.slice() || [],
  };
}

let shared = null;
export function busSource() {
  shared ??= createBusSource();
  return shared;
}

export function busesProxy({ source = null } = {}) {
  const handler = async (req, res) => {
    const send = (status, body) => {
      if (res.headersSent) return;
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': status === 200 ? 'private, max-age=20' : 'no-store',
      });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = String(url.searchParams.get('bbox') || '')
        .split(',')
        .map(Number);
      if (parts.length !== 4 || !parts.every(Number.isFinite))
        return send(400, { error: 'bbox' });
      const [w, s, e, n] = parts;
      if (w >= e || s >= n) return send(400, { error: 'bbox' });
      const result = await (source || busSource()).inBox(parts, {
        linha: String(url.searchParams.get('linha') || '').slice(0, 20),
        seguir: String(url.searchParams.get('seguir') || '').slice(0, 60),
      });
      return send(200, { fetchedAt: Date.now(), ...result });
    } catch (err) {
      console.warn('[onibus]', err?.message || err);
      return send(502, { error: 'onibus_indisponiveis' });
    }
  };
  const install = (server) => {
    server.middlewares.use('/api/br/onibus', handler);
  };
  return {
    name: 'barreto-buses',
    configureServer: install,
    configurePreviewServer: install,
  };
}
