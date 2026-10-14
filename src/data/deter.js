/**
 * barreto.top: INPE DETER deforestation/degradation alerts (Amazônia and
 * Cerrado) from the public TerraBrasilis WFS, reduced to one point per
 * alert polygon. The polygons are small (typically well under 1 km²), so a
 * coloured point reads better at national scale than the outline would.
 */

export const DETER_CLASSES = Object.freeze({
  DESMATAMENTO_CR: {
    label: 'Desmatamento (corte raso)',
    color: '#ff3b30',
    rank: 5,
  },
  DESMATAMENTO_VEG: {
    label: 'Desmatamento com vegetação',
    color: '#ff6b3d',
    rank: 4,
  },
  MINERACAO: { label: 'Mineração', color: '#bf5af2', rank: 4 },
  DEGRADACAO: { label: 'Degradação', color: '#ff9f0a', rank: 3 },
  CS_DESORDENADO: {
    label: 'Corte seletivo desordenado',
    color: '#f4a261',
    rank: 2,
  },
  CS_GEOMETRICO: {
    label: 'Corte seletivo geométrico',
    color: '#f4a261',
    rank: 2,
  },
  CICATRIZ_DE_QUEIMADA: {
    label: 'Cicatriz de queimada',
    color: '#ffd60a',
    rank: 1,
  },
});
const OTHER_CLASS = Object.freeze({
  label: 'Alerta DETER',
  color: '#ffffff',
  rank: 0,
});

export const DETER_BIOMES = Object.freeze({
  amz: {
    label: 'Amazônia',
    typeName: 'deter-amz:deter_amz',
  },
  cerrado: {
    label: 'Cerrado',
    typeName: 'deter-cerrado-nb:deter_cerrado',
  },
});

/** Area-weighted centroid of a ring of [lon, lat] (vertex mean if degenerate). */
export function ringCentroid(ring) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const n = Math.max(1, ring.length);
    return {
      lon: ring.reduce((s, p) => s + p[0], 0) / n,
      lat: ring.reduce((s, p) => s + p[1], 0) / n,
    };
  }
  return { lon: cx / (3 * a), lat: cy / (3 * a) };
}

/** Largest outer ring of a (Multi)Polygon geometry, or null. */
function largestOuterRing(geometry) {
  const polys =
    geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  let best = null;
  let bestArea = -1;
  for (const rings of polys) {
    const ring = rings?.[0];
    if (!Array.isArray(ring) || ring.length < 3) continue;
    let s = 0;
    for (let i = 0; i < ring.length - 1; i++)
      s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    if (Math.abs(s) > bestArea) {
      bestArea = Math.abs(s);
      best = ring;
    }
  }
  return best;
}

const titleCase = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (m, pre, ch) => pre + ch.toUpperCase())
    .replace(/\b(Da|Das|De|Do|Dos|E)\b/g, (w) => w.toLowerCase());

const round = (value, digits) => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};

/** "2026-09-13" → epoch ms at noon in Brasília (a date, not an instant). */
export function deterDateMs(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T12:00:00-03:00`) : NaN;
}

/** WFS GeoJSON FeatureCollection → point rows for one biome. */
export function parseDeterFeatures(collection, biomeKey) {
  const biome = DETER_BIOMES[biomeKey];
  const features = Array.isArray(collection?.features)
    ? collection.features
    : [];
  const rows = [];
  for (const feature of features) {
    const p = feature?.properties || {};
    const ring = largestOuterRing(feature?.geometry);
    if (!ring) continue;
    const { lon, lat } = ringCentroid(ring);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -34.5 || lat > 6 || lon < -74.5 || lon > -32) continue;
    const kind = DETER_CLASSES[p.classname] || OTHER_CLASS;
    const area = Number(p.areatotalkm ?? p.areamunkm);
    const gid = String(p.gid ?? feature.id ?? '').replace(/[^\w.-]/g, '');
    if (!gid) continue;
    rows.push({
      stableId: `${biomeKey}-${gid}`,
      lat: round(lat, 5),
      lon: round(lon, 5),
      className: String(p.classname || ''),
      label: kind.label,
      color: kind.color,
      rank: kind.rank,
      areaKm2: Number.isFinite(area) ? round(area, 3) : null,
      municipality: titleCase(p.municipality),
      uf: String(p.uf || '').toUpperCase(),
      biome: biome?.label || biomeKey,
      date: deterDateMs(p.view_date),
      satellite: String(p.satellite || '').trim(),
      sensor: String(p.sensor || '').trim(),
      protectedArea: p.uc ? String(p.uc).trim() : null,
    });
  }
  return rows;
}

/** Most recent first, then most severe; never more than `limit` rows. */
export function sortDeterRows(rows, limit = 8000) {
  return [...rows]
    .sort((a, b) => (b.date || 0) - (a.date || 0) || b.rank - a.rank)
    .slice(0, limit);
}

/** "0,07 km²" / "1,3 km²" / "12 km²". */
export function formatAreaKm2(value) {
  if (!Number.isFinite(value)) return null;
  const digits = value < 1 ? 2 : value < 10 ? 1 : 0;
  return `${value.toLocaleString('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} km²`;
}
