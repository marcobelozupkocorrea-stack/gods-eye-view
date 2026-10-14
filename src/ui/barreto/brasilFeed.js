/**
 * barreto.top: "Brasil agora" feed — turns the Brazilian alert snapshots
 * (INMET, Defesa Civil, Cemaden, DETER) into one sortable, filterable list.
 * Pure: no DOM, no network, so it is unit-tested directly.
 */
import { alertAnchorDegrees } from '../../layers/alerts/cards.js';

export const BRASIL_SOURCES = Object.freeze({
  inmet: Object.freeze({
    label: 'INMET',
    long: 'Avisos do INMET (tempo)',
    layerId: 'inmet-alerts',
    endpoint: '/api/inmet/alerts',
    icon: '⛈',
  }),
  defesa: Object.freeze({
    label: 'Defesa Civil',
    long: 'Alertas da Defesa Civil',
    layerId: 'defesa-civil-alerts',
    endpoint: '/api/defesacivil/alerts',
    icon: '🚨',
  }),
  cemaden: Object.freeze({
    label: 'Cemaden',
    long: 'Riscos do Cemaden (enchente, deslizamento)',
    layerId: 'cemaden-alerts',
    endpoint: '/api/cemaden/alerts',
    icon: '💧',
  }),
  deter: Object.freeze({
    label: 'Desmatamento',
    long: 'Desmatamento (INPE DETER, 30 dias)',
    layerId: 'deter-alerts',
    endpoint: '/api/deter/alerts',
    icon: '🌳',
  }),
});

/** Sources listed when the panel opens (DETER is long; opt-in). */
export const DEFAULT_SOURCES = Object.freeze(['inmet', 'defesa', 'cemaden']);

export const SEVERITY_FILTERS = Object.freeze([
  Object.freeze({ id: 'all', label: 'Todas', min: 0 }),
  Object.freeze({ id: 'high', label: 'Alta ou maior', min: 2 }),
  Object.freeze({ id: 'max', label: 'Só a máxima', min: 3 }),
]);

const DATE = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const DAY = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
});

export const formatWhen = (ms) =>
  Number.isFinite(ms) ? DATE.format(new Date(ms)).replace(',', '') : '';

/** Lower-case, accent-free text for forgiving search ("sao paulo" = "São Paulo"). */
export function foldText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const clip = (text, max) => {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
};

function capItems(rows, sourceKey) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.stableId || !Array.isArray(row.polygons) || !row.polygons.length)
      continue;
    let anchor;
    try {
      anchor = alertAnchorDegrees(row.polygons);
    } catch {
      continue;
    }
    if (!Number.isFinite(anchor?.lat) || !Number.isFinite(anchor?.lon))
      continue;
    const where = row.states || row.areaDesc || '';
    const issuer = sourceKey === 'defesa' ? row.senderName || '' : '';
    out.push({
      key: `${sourceKey}:${row.stableId}`,
      source: sourceKey,
      layerId: BRASIL_SOURCES[sourceKey].layerId,
      stableId: String(row.stableId),
      title:
        `${String(row.event || 'Alerta').toUpperCase()} · ${row.severityLabel || ''}`.replace(
          / · $/,
          '',
        ),
      subtitle: clip(where, 90),
      detail: issuer ? clip(issuer, 60) : '',
      when: Number.isFinite(row.onset) ? row.onset : null,
      until: Number.isFinite(row.expires) ? row.expires : null,
      severity: Number.isFinite(row.severityRank) ? row.severityRank : 1,
      color: row.color || '#ffd600',
      lat: anchor.lat,
      lon: anchor.lon,
      // State-wide polygons: frame from high up.
      altitude: 900_000,
      search: foldText([row.event, where, issuer, row.severityLabel].join(' ')),
    });
  }
  return out;
}

function cemadenItems(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(
      (r) => r?.stableId && Number.isFinite(r.lat) && Number.isFinite(r.lon),
    )
    .map((r) => {
      const place = [r.municipality, r.uf].filter(Boolean).join('/');
      return {
        key: `cemaden:${r.stableId}`,
        source: 'cemaden',
        layerId: BRASIL_SOURCES.cemaden.layerId,
        stableId: String(r.stableId),
        title: `${String(r.event || 'Alerta').toUpperCase()} · ${r.level}`,
        subtitle: place,
        detail: '',
        when: Number.isFinite(r.updated) ? r.updated : (r.created ?? null),
        until: null,
        // Cemaden levels: Moderado 1, Alto 2, Muito Alto 3 (same scale).
        severity: r.rank || 1,
        color: r.color || '#ffd60a',
        lat: r.lat,
        lon: r.lon,
        altitude: 60_000,
        search: foldText([r.event, r.level, place].join(' ')),
      };
    });
}

function deterItems(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(
      (r) => r?.stableId && Number.isFinite(r.lat) && Number.isFinite(r.lon),
    )
    .map((r) => {
      const place = [r.municipality, r.uf].filter(Boolean).join('/');
      const area = Number.isFinite(r.areaKm2)
        ? `${r.areaKm2.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} km²`
        : '';
      return {
        key: `deter:${r.stableId}`,
        source: 'deter',
        layerId: BRASIL_SOURCES.deter.layerId,
        stableId: String(r.stableId),
        title: String(r.label || 'Alerta DETER').toUpperCase(),
        subtitle: [place, r.biome].filter(Boolean).join(' · '),
        detail: [
          area,
          Number.isFinite(r.date)
            ? `visto em ${DAY.format(new Date(r.date))}`
            : '',
        ]
          .filter(Boolean)
          .join(' · '),
        when: Number.isFinite(r.date) ? r.date : null,
        until: null,
        // Deforestation is a slow signal; clear-cut counts as "high".
        severity:
          r.className?.startsWith('DESMATAMENTO') || r.className === 'MINERACAO'
            ? 2
            : 1,
        color: r.color || '#ff3b30',
        lat: r.lat,
        lon: r.lon,
        altitude: 25_000,
        search: foldText([r.label, place, r.biome].join(' ')),
      };
    });
}

/** Snapshot rows per source → unified items. */
export function toBrasilItems({ inmet, defesa, cemaden, deter } = {}) {
  return [
    ...capItems(inmet, 'inmet'),
    ...capItems(defesa, 'defesa'),
    ...cemadenItems(cemaden),
    ...deterItems(deter),
  ];
}

/** Most severe first, then most recent. */
export function sortBrasilItems(items) {
  return [...items].sort(
    (a, b) => b.severity - a.severity || (b.when ?? 0) - (a.when ?? 0),
  );
}

/**
 * Filter by source keys, minimum severity and free text. Text matches any
 * word in place/event/issuer, accent-insensitive; "SP" also matches "/SP"
 * and "São Paulo".
 */
export function filterBrasilItems(
  items,
  { sources, minSeverity = 0, text = '' } = {},
) {
  const allowed = sources ? new Set(sources) : null;
  const words = foldText(text)
    .split(/[\s,]+/)
    .filter(Boolean);
  return items.filter((item) => {
    if (allowed && !allowed.has(item.source)) return false;
    if (item.severity < minSeverity) return false;
    return words.every((word) => matchesWord(item, word));
  });
}

const UF_NAMES = Object.freeze({
  ac: 'acre',
  al: 'alagoas',
  ap: 'amapa',
  am: 'amazonas',
  ba: 'bahia',
  ce: 'ceara',
  df: 'distrito federal',
  es: 'espirito santo',
  go: 'goias',
  ma: 'maranhao',
  mt: 'mato grosso',
  ms: 'mato grosso do sul',
  mg: 'minas gerais',
  pa: 'para',
  pb: 'paraiba',
  pr: 'parana',
  pe: 'pernambuco',
  pi: 'piaui',
  rj: 'rio de janeiro',
  rn: 'rio grande do norte',
  rs: 'rio grande do sul',
  ro: 'rondonia',
  rr: 'roraima',
  sc: 'santa catarina',
  sp: 'sao paulo',
  se: 'sergipe',
  to: 'tocantins',
});

function matchesWord(item, word) {
  if (word.length === 2 && UF_NAMES[word]) {
    const uf = new RegExp(`(^|[^a-z])${word}([^a-z]|$)`);
    return uf.test(item.search) || item.search.includes(UF_NAMES[word]);
  }
  return item.search.includes(word);
}

/** Counts per source, for the summary chips. */
export function countBySource(items) {
  const counts = Object.fromEntries(
    Object.keys(BRASIL_SOURCES).map((k) => [k, 0]),
  );
  for (const item of items)
    counts[item.source] = (counts[item.source] || 0) + 1;
  return counts;
}
