/**
 * barreto.top: live traffic incidents (accidents, road works, closures,
 * jams…) from TomTom's Incident Details API, for the area on screen.
 *
 *   GET /api/br/ocorrencias?bbox=w,s,e,n
 *     → { fetchedAt, items: [...], tooWide?, budget? }
 *
 * TomTom limits each request to 10 000 km², so the view is split into
 * 0.5° cells (≈ 2 900 km² at São Paulo's latitude), cached for 3 minutes and
 * fetched only while the camera is close enough (at most 12 cells). A daily
 * budget keeps the free key safe. Without a key the endpoint says so.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { barretoDataDir } from './barretoPlaces.js';

const CELL = 0.5;
const MAX_CELLS = 12;
const CELL_TTL_MS = 3 * 60_000;
const DEFAULT_DAILY_BUDGET = 1500;

/** TomTom iconCategory → kind + Portuguese label. */
export const INCIDENT_KINDS = Object.freeze({
  0: ['outro', 'Ocorrência'],
  1: ['acidente', 'Acidente'],
  2: ['neblina', 'Neblina'],
  3: ['perigo', 'Condição perigosa'],
  4: ['chuva', 'Chuva'],
  5: ['gelo', 'Pista escorregadia'],
  6: ['congestionamento', 'Congestionamento'],
  7: ['faixa', 'Faixa interditada'],
  8: ['bloqueio', 'Via bloqueada'],
  9: ['obra', 'Obra na pista'],
  10: ['vento', 'Vento forte'],
  11: ['alagamento', 'Alagamento'],
  14: ['quebrado', 'Veículo quebrado'],
});

export const DELAY_LABELS = Object.freeze({
  0: 'atraso desconhecido',
  1: 'atraso pequeno',
  2: 'atraso moderado',
  3: 'atraso grande',
  4: 'via parada',
});

/**
 * TomTom only offers European Portuguese; swap the common phrases for the
 * words used on Brazilian roads.
 */
const PT_BR = [
  [/^Encerrad[oa](\/a)?$/i, 'Via interditada'],
  [/Encerrad[oa](\/a)?/gi, 'interditada'],
  [/Nova disposição de trabalhos na estrada/gi, 'Obra com novo desvio'],
  [/Trabalhos na estrada/gi, 'Obra na pista'],
  [/Filas de trânsito/gi, 'Fila'],
  [/faixa(s)? fechada(s)?/gi, 'faixa$1 interditada$2'],
  [/Veículo avariado/gi, 'Veículo quebrado'],
  [/avariado/gi, 'quebrado'],
  [/Acidente\(s\)/gi, 'Acidente'],
];
export function brText(text) {
  let out = String(text || '').trim();
  for (const [re, to] of PT_BR) out = out.replace(re, to);
  return out;
}

/** Plain jams are left out: the coloured roads already show them. */
const CATEGORIES = '0,1,2,3,4,5,7,8,9,10,11,14';

const FIELDS =
  '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity}}}';

/** Cells (south-west corners) covering a bbox, or null when too many. */
export function cellsFor([w, s, e, n], max = MAX_CELLS) {
  const cells = [];
  for (let lat = Math.floor(s / CELL) * CELL; lat < n; lat += CELL)
    for (let lon = Math.floor(w / CELL) * CELL; lon < e; lon += CELL) {
      cells.push([Number(lon.toFixed(2)), Number(lat.toFixed(2))]);
      if (cells.length > max) return null;
    }
  return cells;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** One TomTom incident feature → a plain record (or null). */
export function incidentRecord(feature) {
  const p = feature?.properties || {};
  const g = feature?.geometry || {};
  if (!p.id) return null;
  let line = [];
  if (g.type === 'LineString' && Array.isArray(g.coordinates))
    line = g.coordinates.filter(
      (c) => Number.isFinite(c?.[0]) && Number.isFinite(c?.[1]),
    );
  else if (g.type === 'Point' && Array.isArray(g.coordinates))
    line = [g.coordinates];
  if (!line.length) return null;
  const [kind, label] = INCIDENT_KINDS[p.iconCategory] || INCIDENT_KINDS[0];
  const mid = line[Math.floor(line.length / 2)];
  const events = Array.isArray(p.events) ? p.events : [];
  const description = events
    .map((ev) => brText(ev?.description))
    .filter(Boolean)
    .join(' · ');
  const magnitude = Number.isInteger(p.magnitudeOfDelay)
    ? p.magnitudeOfDelay
    : 0;
  return {
    id: String(p.id),
    kind,
    label,
    description: description.slice(0, 200) || label,
    from: String(p.from || '').slice(0, 120),
    to: String(p.to || '').slice(0, 120),
    roads: Array.isArray(p.roadNumbers)
      ? p.roadNumbers.slice(0, 4).map(String)
      : [],
    delayS: num(p.delay),
    lengthM: num(p.length),
    magnitude,
    delayLabel: DELAY_LABELS[magnitude] || DELAY_LABELS[0],
    start: Date.parse(p.startTime) || null,
    end: Date.parse(p.endTime) || null,
    lat: mid[1],
    lon: mid[0],
    // Keep lines light: at most ~120 points.
    line:
      line.length > 120
        ? line.filter(
            (_, i) =>
              i % Math.ceil(line.length / 120) === 0 || i === line.length - 1,
          )
        : line,
  };
}

export function createDailyBudget({
  file,
  limit,
  today = () => new Date().toISOString().slice(0, 10),
}) {
  let state = null;
  let loaded = null;
  async function load() {
    loaded ??= fsp
      .readFile(file, 'utf8')
      .then((t) => {
        const v = JSON.parse(t);
        if (typeof v?.date === 'string' && Number.isFinite(v.count)) state = v;
      })
      .catch(() => {});
    await loaded;
    if (!state || state.date !== today()) state = { date: today(), count: 0 };
    return state;
  }
  return {
    async take() {
      const s = await load();
      if (s.count >= limit) return false;
      s.count += 1;
      fsp
        .mkdir(path.dirname(file), { recursive: true })
        .then(() => fsp.writeFile(file, JSON.stringify(s), 'utf8'))
        .catch(() => {});
      return true;
    },
    async status() {
      const s = await load();
      return { date: s.date, count: s.count, limit };
    },
  };
}

export function createIncidentSource({
  key = process.env.TOMTOM_API_KEY || '',
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  dataDir = barretoDataDir(),
  limit = Number.parseInt(process.env.TOMTOM_DAILY_INCIDENT_BUDGET || '', 10) ||
    DEFAULT_DAILY_BUDGET,
} = {}) {
  const cache = new Map(); // cellKey → { at, items }
  const pending = new Map();
  const budget = createDailyBudget({
    file: path.join(dataDir, 'tomtom', 'incident-budget.json'),
    limit,
  });

  async function fetchCell([lon, lat]) {
    const cellKey = `${lon},${lat}`;
    const hit = cache.get(cellKey);
    if (hit && now() - hit.at < CELL_TTL_MS) return hit.items;
    if (pending.has(cellKey)) return pending.get(cellKey);
    const work = (async () => {
      if (!(await budget.take())) {
        if (hit) return hit.items;
        throw new Error('budget');
      }
      const u = new URL(
        'https://api.tomtom.com/traffic/services/5/incidentDetails',
      );
      u.searchParams.set('key', key);
      u.searchParams.set('bbox', `${lon},${lat},${lon + CELL},${lat + CELL}`);
      u.searchParams.set('fields', FIELDS);
      u.searchParams.set('language', 'pt-PT');
      u.searchParams.set('categoryFilter', CATEGORIES);
      u.searchParams.set('timeValidityFilter', 'present');
      const res = await fetchImpl(u.href, {
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        await res.body?.cancel?.();
        throw new Error(`HTTP ${res.status}`);
      }
      const body = await res.json();
      const items = (Array.isArray(body?.incidents) ? body.incidents : [])
        .map(incidentRecord)
        .filter(Boolean);
      cache.set(cellKey, { at: now(), items });
      while (cache.size > 400) cache.delete(cache.keys().next().value);
      return items;
    })().finally(() => pending.delete(cellKey));
    pending.set(cellKey, work);
    return work;
  }

  /** Incidents inside a bbox (deduplicated across cells). */
  async function inBox(bbox) {
    if (!key) return { items: [], semChave: true };
    const cells = cellsFor(bbox);
    if (!cells) return { items: [], tooWide: true };
    const seen = new Map();
    let failed = 0;
    let budgetOut = false;
    await Promise.all(
      cells.map(async (c) => {
        try {
          for (const item of await fetchCell(c)) seen.set(item.id, item);
        } catch (err) {
          failed += 1;
          if (err?.message === 'budget') budgetOut = true;
        }
      }),
    );
    const [w, s, e, n] = bbox;
    const items = [...seen.values()].filter(
      (i) =>
        i.lon >= w - 0.05 &&
        i.lon <= e + 0.05 &&
        i.lat >= s - 0.05 &&
        i.lat <= n + 0.05,
    );
    items.sort(
      (a, b) => b.magnitude - a.magnitude || (b.delayS || 0) - (a.delayS || 0),
    );
    return { items, failedCells: failed, budgetOut };
  }

  return { inBox, budget };
}

export function parseBbox(text) {
  const parts = String(text || '')
    .split(',')
    .map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
  const [w, s, e, n] = parts;
  if (
    w >= e ||
    s >= n ||
    Math.abs(s) > 90 ||
    Math.abs(n) > 90 ||
    Math.abs(w) > 180 ||
    Math.abs(e) > 180
  )
    return null;
  return [w, s, e, n];
}

/** The plugin; the source is shared with the alerts hub (areas, summary). */
let sharedSource = null;
export function incidentSource() {
  sharedSource ??= createIncidentSource();
  return sharedSource;
}

export function trafficIncidentsProxy({ source = null } = {}) {
  const handler = async (req, res) => {
    const send = (status, body) => {
      if (res.headersSent) return;
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': status === 200 ? 'private, max-age=60' : 'no-store',
      });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const bbox = parseBbox(url.searchParams.get('bbox'));
      if (!bbox) return send(400, { error: 'bbox' });
      const result = await (source || incidentSource()).inBox(bbox);
      return send(200, { fetchedAt: Date.now(), ...result });
    } catch (err) {
      console.warn('[ocorrencias]', err?.message || err);
      return send(502, { error: 'ocorrencias_indisponiveis' });
    }
  };
  const install = (server) => {
    server.middlewares.use('/api/br/ocorrencias', handler);
  };
  return {
    name: 'barreto-traffic-incidents',
    configureServer: install,
    configurePreviewServer: install,
  };
}
