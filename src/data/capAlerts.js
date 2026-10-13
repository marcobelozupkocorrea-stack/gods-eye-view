/**
 * OASIS CAP 1.2 alerts → plain rows the globe can draw.
 *
 * Shared by the Brazilian alert layers: INMET weather warnings (one CAP
 * document per RSS item) and Defesa Civil alerts from the national IDAP feed
 * (an Atom feed whose entries embed CAP alerts). Pure: no I/O, no globals,
 * no XML dependency — CAP is flat enough for a tolerant tag reader.
 */

/** Defesa Civil / generic CAP severity → Portuguese label and colour. */
export const CAP_SEVERITY = Object.freeze({
  Minor: Object.freeze({ label: 'Observação', color: '#9ccc65', rank: 0 }),
  Moderate: Object.freeze({ label: 'Moderado', color: '#ffd600', rank: 1 }),
  Severe: Object.freeze({ label: 'Severo', color: '#ff6d00', rank: 2 }),
  Extreme: Object.freeze({ label: 'Extremo', color: '#d50000', rank: 3 }),
});

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode XML entities and CDATA wrappers in element text. */
export function decodeXmlText(text) {
  return String(text ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] === '#') {
        const n =
          code[1] === 'x' || code[1] === 'X'
            ? parseInt(code.slice(2), 16)
            : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : match;
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .trim();
}

/** Inner XML of every `<name>` element (namespace prefixes tolerated). */
export function elements(xml, name) {
  const pattern = new RegExp(
    `<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`,
    'gi',
  );
  const found = [];
  for (const match of String(xml).matchAll(pattern)) found.push(match[1]);
  return found;
}

export function first(xml, name) {
  const [value] = elements(xml, name);
  return value === undefined ? '' : decodeXmlText(value);
}

/**
 * CAP polygon text ("lat,lon lat,lon …") → closed [lon, lat] ring, or null
 * when it has fewer than three valid vertices.
 */
export function parseCapPolygon(text) {
  const ring = [];
  for (const pair of String(text || '')
    .trim()
    .split(/\s+/)) {
    const [latText, lonText] = pair.split(',');
    const lat = Number(latText);
    const lon = Number(lonText);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    ring.push([round4(lon), round4(lat)]);
  }
  if (ring.length < 3) return null;
  const [firstLon, firstLat] = ring[0];
  const [lastLon, lastLat] = ring[ring.length - 1];
  if (firstLon !== lastLon || firstLat !== lastLat)
    ring.push([firstLon, firstLat]);
  return ring.length >= 4 ? ring : null;
}

/** Most vertices kept per ring: INMET areas follow municipal borders and can
 * carry thousands of points, which a whole-country view does not need. */
export const MAX_RING_VERTICES = 600;

/** Evenly decimate a closed ring to at most MAX_RING_VERTICES points. */
export function thinRing(ring, max = MAX_RING_VERTICES) {
  if (ring.length <= max) return ring;
  const open = ring.slice(0, -1);
  const step = open.length / (max - 1);
  const thinned = [];
  for (let i = 0; i < max - 1; i++) thinned.push(open[Math.floor(i * step)]);
  thinned.push(thinned[0]);
  return thinned;
}

/** ~11 m precision is plenty for warning areas and halves the payload. */
function round4(value) {
  return Math.round(value * 1e4) / 1e4;
}

function parameters(info) {
  const map = new Map();
  for (const parameter of elements(info, 'parameter')) {
    const name = first(parameter, 'valueName');
    if (name) map.set(name, first(parameter, 'value'));
  }
  return map;
}

function timeMs(text) {
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse one CAP alert into a warning row, or null when it is not a drawable,
 * current warning (a cancellation, a test, or one without areas).
 * @param {string} xml CAP 1.2 alert (a document, or an alert embedded in a feed).
 * @param {string} id Stable warning id.
 * @param {{ scale?: object, maxRingVertices?: number }} [options] Severity
 *   labels/colours, and the per-ring vertex budget.
 */
export function parseCapAlert(
  xml,
  id,
  { scale = CAP_SEVERITY, maxRingVertices = MAX_RING_VERTICES } = {},
) {
  if (typeof xml !== 'string' || !/<(?:[\w-]+:)?alert[\s>]/i.test(xml))
    return null;
  const msgType = first(xml, 'msgType');
  const status = first(xml, 'status');
  if (/^cancel$/i.test(msgType) || (status && !/^actual$/i.test(status)))
    return null;
  const [info] = elements(xml, 'info');
  if (!info) return null;
  const polygons = [];
  const areaNames = [];
  for (const area of elements(info, 'area')) {
    const desc = first(area, 'areaDesc');
    if (
      desc &&
      !areaNames.includes(desc.replace(/^aviso para as áreas:\s*/i, ''))
    )
      areaNames.push(desc.replace(/^aviso para as áreas:\s*/i, ''));
    for (const polygon of elements(area, 'polygon')) {
      const ring = parseCapPolygon(decodeXmlText(polygon));
      if (ring) polygons.push([thinRing(ring, maxRingVertices)]);
    }
  }
  if (!polygons.length) return null;
  const params = parameters(info);
  const severity = first(info, 'severity');
  const grade = scale[severity] || scale.Moderate;
  const color = /^#[0-9a-f]{6}$/i.test(params.get('ColorRisk') || '')
    ? params.get('ColorRisk')
    : grade.color;
  return {
    stableId: String(id),
    event: first(info, 'event') || 'Aviso',
    severity: severity || null,
    severityLabel: grade.label,
    severityRank: grade.rank,
    color,
    headline: first(info, 'headline') || null,
    description: first(info, 'description') || null,
    instruction: first(info, 'instruction') || null,
    onset: timeMs(first(info, 'onset')),
    expires: timeMs(first(info, 'expires')),
    sent: timeMs(first(xml, 'sent')),
    areaDesc: areaNames.join('; ') || null,
    states: params.get('Estados') || null,
    senderName: first(info, 'senderName') || null,
    web: first(info, 'web') || null,
    polygons,
  };
}

/** Keep warnings that have not expired yet (onset may be in the future). */
export function isCurrentWarning(row, nowMs) {
  return !Number.isFinite(row?.expires) || row.expires > nowMs;
}

/**
 * Split an Atom feed whose entries embed CAP alerts (the IDAP national feed)
 * into { id, xml } pairs, where xml is the embedded <alert> element.
 */
export function parseAtomCapEntries(feedXml) {
  const entries = [];
  for (const entry of elements(feedXml, 'entry')) {
    const alertMatch =
      /<(?:[\w-]+:)?alert[\s>][\s\S]*<\/(?:[\w-]+:)?alert>/i.exec(entry);
    if (!alertMatch) continue;
    const id = first(alertMatch[0], 'identifier') || first(entry, 'id');
    if (!id) continue;
    entries.push({ id, xml: alertMatch[0] });
  }
  return entries;
}
