/**
 * barreto.top: one model for the Brazilian alerts.
 *
 * INMET, Defesa Civil (IDAP) and Cemaden each describe risk their own way
 * (CAP polygons, municipal points, different severity words). Here every
 * alert becomes the same record — kind of hazard, a 1–3 level, the
 * municipalities it covers — so they can be grouped by state and city, merged
 * when two sources warn about the same thing in the same place, matched to a
 * point ("perto de mim", notifications) and stored in the history.
 *
 * Pure: no I/O. The municipality list (IBGE centroids) is passed in.
 */

export const LEVELS = Object.freeze({
  0: 'Observação',
  1: 'Moderado',
  2: 'Alto',
  3: 'Extremo',
});

export const SOURCE_LABEL = Object.freeze({
  inmet: 'INMET',
  defesa: 'Defesa Civil',
  cemaden: 'Cemaden',
});

/** Hazard kinds, most specific first. */
export const KINDS = Object.freeze([
  ['granizo', 'Granizo', /granizo/],
  [
    'deslizamento',
    'Deslizamento',
    /desliza|movimentos? de massa|escorrega|desmorona|geol/,
  ],
  [
    'inundacao',
    'Enchente e alagamento',
    /inunda|alaga|enxurrada|enchente|hidrol|transbord|cheia/,
  ],
  ['chuva', 'Chuva forte', /chuv|tempestade|temporal|precipita|acumulado/],
  ['vento', 'Vento forte', /vento|vendaval|ciclone|tornado|rajada/],
  ['mar', 'Mar agitado', /ressaca|ondas|mar agitado|marinh/],
  ['seco', 'Tempo seco', /umidade|estiagem|\bseca\b|tempo seco/],
  ['calor', 'Calor', /calor|temperaturas? alta|altas temperaturas/],
  [
    'frio',
    'Frio e geada',
    /frio|geada|decl[ií]nio de temperatura|baixas temperaturas|neve/,
  ],
  ['incendio', 'Incêndio', /inc[eê]ndio|queimada|fogo/],
]);
const OTHER = ['outro', 'Outros alertas'];

export const KIND_LABEL = Object.freeze(
  Object.fromEntries([...KINDS.map(([k, l]) => [k, l]), OTHER]),
);

export function foldText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export function kindOf(text) {
  const t = foldText(text);
  for (const [kind, , pattern] of KINDS) if (pattern.test(t)) return kind;
  return OTHER[0];
}

// ------------------------------------------------------------ municipalities

/**
 * Index the IBGE list `{ estados: {UF: nome}, municipios: [[code, nome, lat,
 * lon, UF], …] }` for lookups by name, by point and by polygon.
 */
export function indexMunicipios(data) {
  const list = (data?.municipios || []).map(([code, nome, lat, lon, uf]) => ({
    code,
    nome,
    lat,
    lon,
    uf,
  }));
  const byCode = new Map(list.map((m) => [m.code, m]));
  const byName = new Map();
  for (const m of list) byName.set(`${foldText(m.nome)}|${m.uf}`, m);
  // 1° grid for nearest-centroid lookups.
  const grid = new Map();
  const cell = (lat, lon) => `${Math.floor(lat)}|${Math.floor(lon)}`;
  for (const m of list) {
    const key = cell(m.lat, m.lon);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(m);
  }
  const estados = data?.estados || {};
  const ufByName = new Map(
    Object.entries(estados).map(([uf, nome]) => [foldText(nome), uf]),
  );
  return {
    list,
    byCode,
    estados,
    find: (nome, uf) =>
      byName.get(`${foldText(nome)}|${String(uf || '').toUpperCase()}`) || null,
    ufOfName: (nome) => ufByName.get(foldText(nome)) || null,
    nearest(lat, lon, maxKm = 60) {
      let best = null;
      let bestD = Infinity;
      const la = Math.floor(lat);
      const lo = Math.floor(lon);
      for (let i = -1; i <= 1; i += 1)
        for (let j = -1; j <= 1; j += 1)
          for (const m of grid.get(`${la + i}|${lo + j}`) || []) {
            const d = distanceKm(lat, lon, m.lat, m.lon);
            if (d < bestD) {
              bestD = d;
              best = m;
            }
          }
      return bestD <= maxKm ? best : null;
    },
  };
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) *
      Math.cos(lat2 * r) *
      Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Ray casting on a [lon, lat] ring. */
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi
    )
      inside = !inside;
  }
  return inside;
}

/** polygons: [[outerRing, …holes], …] */
export function pointInPolygons(lon, lat, polygons) {
  for (const polygon of polygons || []) {
    const [outer, ...holes] = polygon || [];
    if (!outer || !pointInRing(lon, lat, outer)) continue;
    if (holes.some((h) => pointInRing(lon, lat, h))) continue;
    return true;
  }
  return false;
}

export function bboxOf(polygons) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const polygon of polygons || [])
    for (const [lon, lat] of polygon?.[0] || []) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

function municipiosIn(polygons, bbox, index) {
  if (!bbox) return [];
  const [w, s, e, n] = bbox;
  const out = [];
  for (const m of index.list) {
    if (m.lon < w || m.lon > e || m.lat < s || m.lat > n) continue;
    if (pointInPolygons(m.lon, m.lat, polygons)) out.push(m.code);
  }
  return out;
}

/** "SÃO PAULO/SP; Santos/SP" → municipality codes. */
function municipiosFromText(text, index) {
  const out = [];
  for (const m of String(text || '').matchAll(
    /([^;,/]+?)\s*[/-]\s*([A-Z]{2})\b/g,
  )) {
    const hit = index.find(m[1], m[2]);
    if (hit) out.push(hit.code);
  }
  return out;
}

function ufsFromText(text, index) {
  const out = new Set();
  for (const part of String(text || '').split(/[,;]| e /)) {
    const uf = index.ufOfName(part);
    if (uf) out.add(uf);
  }
  return [...out];
}

const clip = (text, max) => {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
};

// ------------------------------------------------------------ unify

/**
 * Snapshot rows → unified alerts.
 * @param {{ inmet?: object[], defesa?: object[], cemaden?: object[] }} rows
 * @param {ReturnType<typeof indexMunicipios>} index
 */
export function unifyAlerts({ inmet = [], defesa = [], cemaden = [] }, index) {
  const out = [];
  const cap = (rows, source) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row?.stableId || !Array.isArray(row.polygons)) continue;
      const bbox = bboxOf(row.polygons);
      if (!bbox) continue;
      let cities = municipiosIn(row.polygons, bbox, index);
      if (!cities.length) cities = municipiosFromText(row.areaDesc, index);
      const ufs = new Set(cities.map((c) => index.byCode.get(c)?.uf));
      for (const uf of ufsFromText(row.states, index)) ufs.add(uf);
      ufs.delete(undefined);
      const rank = Number.isFinite(row.severityRank) ? row.severityRank : 1;
      out.push({
        id: `${source}:${row.stableId}`,
        source,
        stableId: String(row.stableId),
        // The event names the hazard; the headline only helps when it does not.
        kind:
          kindOf(row.event) === 'outro'
            ? kindOf(row.headline)
            : kindOf(row.event),
        event: clip(row.event || 'Alerta', 80),
        rank: Math.max(0, Math.min(3, rank)),
        level: row.severityLabel || LEVELS[rank] || '',
        headline: clip(row.headline, 200),
        issuer: clip(row.senderName, 80),
        areaText: clip(row.states || row.areaDesc, 200),
        onset: Number.isFinite(row.onset) ? row.onset : null,
        expires: Number.isFinite(row.expires) ? row.expires : null,
        bbox,
        center: { lat: (bbox[1] + bbox[3]) / 2, lon: (bbox[0] + bbox[2]) / 2 },
        cities,
        ufs: [...ufs].sort(),
        polygons: row.polygons,
      });
    }
  };
  cap(inmet, 'inmet');
  cap(defesa, 'defesa');
  for (const row of Array.isArray(cemaden) ? cemaden : []) {
    if (!row?.stableId || !Number.isFinite(row.lat)) continue;
    const city =
      index.find(row.municipality, row.uf) || index.nearest(row.lat, row.lon);
    out.push({
      id: `cemaden:${row.stableId}`,
      source: 'cemaden',
      stableId: String(row.stableId),
      kind: kindOf(row.event),
      event: clip(row.event || 'Alerta', 80),
      rank: Math.max(1, Math.min(3, row.rank || 1)),
      level: row.level || '',
      headline: '',
      issuer: 'Cemaden',
      areaText: [row.municipality, row.uf].filter(Boolean).join('/'),
      onset: Number.isFinite(row.created) ? row.created : null,
      expires: null,
      updated: Number.isFinite(row.updated) ? row.updated : null,
      bbox: [row.lon, row.lat, row.lon, row.lat],
      center: { lat: row.lat, lon: row.lon },
      cities: city ? [city.code] : [],
      ufs: [city?.uf || row.uf].filter(Boolean),
      polygons: null,
    });
  }
  return out;
}

/** Does this alert cover a point? Cemaden points count within `nearKm`. */
export function alertCovers(
  alert,
  lat,
  lon,
  { cityCode = null, nearKm = 12 } = {},
) {
  if (alert.polygons) {
    const [w, s, e, n] = alert.bbox;
    if (lon < w || lon > e || lat < s || lat > n) return false;
    return pointInPolygons(lon, lat, alert.polygons);
  }
  if (cityCode && alert.cities.includes(cityCode)) return true;
  return distanceKm(lat, lon, alert.center.lat, alert.center.lon) <= nearKm;
}

/**
 * Merge alerts about the same hazard: one entry per kind with the highest
 * level, every source that warned and the latest end time.
 */
export function mergeHazards(alerts) {
  const byKind = new Map();
  for (const a of alerts) {
    let h = byKind.get(a.kind);
    if (!h) {
      h = {
        kind: a.kind,
        label: KIND_LABEL[a.kind],
        rank: 0,
        sources: new Set(),
        ids: [],
        events: new Set(),
        until: null,
        open: false,
      };
      byKind.set(a.kind, h);
    }
    h.rank = Math.max(h.rank, a.rank);
    h.sources.add(a.source);
    h.ids.push(a.id);
    h.events.add(a.event);
    if (a.expires === null) h.open = true;
    else if (h.until === null || a.expires > h.until) h.until = a.expires;
  }
  return [...byKind.values()]
    .map((h) => ({
      kind: h.kind,
      label: h.label,
      rank: h.rank,
      level: LEVELS[h.rank],
      sources: [...h.sources].map((s) => SOURCE_LABEL[s]),
      events: [...h.events].slice(0, 4),
      ids: h.ids,
      until: h.open ? null : h.until,
    }))
    .sort((a, b) => b.rank - a.rank || a.label.localeCompare(b.label, 'pt'));
}

/** Per-state summary (for the "Por lugar" list). */
export function statesSummary(alerts, index) {
  const states = new Map();
  for (const a of alerts) {
    for (const uf of a.ufs) {
      let s = states.get(uf);
      if (!s) {
        s = {
          uf,
          nome: index.estados[uf] || uf,
          ids: new Set(),
          cities: new Set(),
          rank: 0,
          kinds: new Map(),
        };
        states.set(uf, s);
      }
      s.ids.add(a.id);
      s.rank = Math.max(s.rank, a.rank);
      s.kinds.set(a.kind, Math.max(s.kinds.get(a.kind) || 0, a.rank));
      for (const c of a.cities)
        if (index.byCode.get(c)?.uf === uf) s.cities.add(c);
    }
  }
  return [...states.values()]
    .map((s) => ({
      uf: s.uf,
      nome: s.nome,
      alertas: s.ids.size,
      cidades: s.cities.size,
      rank: s.rank,
      level: LEVELS[s.rank],
      tipos: [...s.kinds.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([kind, rank]) => ({ kind, label: KIND_LABEL[kind], rank })),
    }))
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        b.alertas - a.alertas ||
        a.nome.localeCompare(b.nome, 'pt'),
    );
}

/** Cities of one state with their merged hazards. */
export function citiesOfState(alerts, uf, index) {
  const cities = new Map();
  for (const a of alerts) {
    if (!a.ufs.includes(uf)) continue;
    for (const code of a.cities) {
      const m = index.byCode.get(code);
      if (!m || m.uf !== uf) continue;
      if (!cities.has(code)) cities.set(code, { m, alerts: [] });
      cities.get(code).alerts.push(a);
    }
  }
  return [...cities.values()]
    .map(({ m, alerts: list }) => {
      const riscos = mergeHazards(list);
      return {
        code: m.code,
        nome: m.nome,
        uf: m.uf,
        lat: m.lat,
        lon: m.lon,
        rank: riscos[0]?.rank || 0,
        riscos,
      };
    })
    .sort((a, b) => b.rank - a.rank || a.nome.localeCompare(b.nome, 'pt'));
}

/** Alerts that cover a point, merged, plus the municipality there. */
export function alertsNear(alerts, lat, lon, index) {
  const city = index.nearest(lat, lon);
  const hits = alerts.filter((a) =>
    alertCovers(a, lat, lon, { cityCode: city?.code }),
  );
  return {
    lugar: city ? { code: city.code, nome: city.nome, uf: city.uf } : null,
    riscos: mergeHazards(hits),
    alertas: hits.map(publicAlert),
  };
}

/** What goes to browsers and the history: no polygons, no long city lists. */
export function publicAlert(a) {
  return {
    id: a.id,
    source: a.source,
    fonte: SOURCE_LABEL[a.source],
    stableId: a.stableId,
    kind: a.kind,
    tipo: KIND_LABEL[a.kind],
    event: a.event,
    rank: a.rank,
    level: a.level,
    headline: a.headline,
    issuer: a.issuer,
    areaText: a.areaText,
    onset: a.onset,
    expires: a.expires,
    center: a.center,
    ufs: a.ufs,
    nCidades: a.cities.length,
  };
}
