/**
 * INMET (Instituto Nacional de Meteorologia) weather warnings.
 *
 * INMET publishes its active warnings as an RSS list
 * (https://apiprevmet3.inmet.gov.br/avisos/rss) whose items link to one
 * OASIS CAP 1.2 document each. CAP parsing is shared in capAlerts.js.
 */
import { elements, first, parseCapAlert } from './capAlerts.js';

export {
  decodeXmlText,
  isCurrentWarning,
  parseCapPolygon,
  thinRing,
  MAX_RING_VERTICES,
} from './capAlerts.js';

/** INMET grade (CAP severity) → Portuguese label and fallback colour. */
export const INMET_SEVERITY = Object.freeze({
  Minor: Object.freeze({ label: 'Observação', color: '#9ccc65', rank: 0 }),
  Moderate: Object.freeze({
    label: 'Perigo Potencial',
    color: '#ffd600',
    rank: 1,
  }),
  Severe: Object.freeze({ label: 'Perigo', color: '#ff9800', rank: 2 }),
  Extreme: Object.freeze({ label: 'Grande Perigo', color: '#e53935', rank: 3 }),
});

/** Warning ids listed in the INMET RSS feed, newest first, de-duplicated. */
export function parseInmetRssIds(xml) {
  const ids = [];
  const seen = new Set();
  for (const item of elements(xml, 'item')) {
    const link = first(item, 'link') || first(item, 'guid');
    const match = /\/avisos\/rss\/(\d+)\b/.exec(link);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    ids.push(match[1]);
  }
  return ids;
}

/** Parse one INMET CAP document (see parseCapAlert). */
export function parseInmetCap(xml, id) {
  return parseCapAlert(xml, id, { scale: INMET_SEVERITY });
}
