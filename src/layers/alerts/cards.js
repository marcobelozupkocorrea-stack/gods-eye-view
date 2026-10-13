import { CAP_SEVERITY } from '../../data/capAlerts.js';

export const INMET_OVERLAY_SOURCE_ID = 'inmet-alerts';
export const DEFESA_CIVIL_OVERLAY_SOURCE_ID = 'defesa-civil-alerts';

const TIME_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** "14/10 00:01" in Brasília time, or null. */
export function formatBrasiliaTime(ms) {
  if (!Number.isFinite(ms)) return null;
  return TIME_FORMAT.format(new Date(ms)).replace(',', '');
}

function clip(text, max) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** Card colour for a warning: the source's own colour, else the grade colour. */
export function alertAccent(row) {
  return row?.color || CAP_SEVERITY[row?.severity]?.color || '#ffd600';
}
export const inmetAccent = alertAccent;

/** Detail card for a selected INMET warning (Portuguese, Brasília time). */
export function buildInmetCard(row, nowMs) {
  // INMET signs as "Instituto Nacional de Meteorologia"; the acronym reads better.
  return buildAlertCard({ ...row, senderName: null }, nowMs, {
    idPrefix: 'inmet-alert-card',
    source: 'INMET',
  });
}

/**
 * Detail card for any selected CAP warning. `source` is the fallback credit
 * when the alert names no sender (Defesa Civil alerts name the issuing state).
 */
export function buildAlertCard(
  row,
  nowMs,
  { idPrefix = 'alert-card', source = '' } = {},
) {
  const details = [];
  const start = formatBrasiliaTime(row.onset);
  const end = formatBrasiliaTime(row.expires);
  if (start || end) {
    const upcoming = Number.isFinite(row.onset) && row.onset > nowMs;
    details.push(
      `${upcoming ? 'começa' : 'desde'} ${start || '?'} · até ${end || '?'}`,
    );
  }
  const where = clip(row.states || row.areaDesc, 110);
  const headline =
    row.headline && row.headline !== row.description
      ? clip(row.headline.replace(/^defesa civil\s*:\s*/i, ''), 140)
      : null;
  if (where) details.push(where);
  const description = clip(row.description, 170) || headline;
  if (description) details.push(description);
  const instruction = clip(row.instruction, 90);
  if (instruction) details.push(instruction);
  const credit = row.senderName || source;
  if (credit) details.push(`Fonte: ${credit}`);
  return {
    id: `${idPrefix}:${row.stableId}`,
    selected: true,
    interactive: false,
    title: `⚠ ${String(row.event || 'Aviso').toUpperCase()} · ${row.severityLabel || 'Aviso'}`,
    details,
    accent: alertAccent(row),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Vertex mean of the largest outer ring — where the card is anchored. */
export function alertAnchorDegrees(polygons) {
  let best = null;
  let bestArea = -1;
  for (const rings of polygons) {
    const ring = rings[0];
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++)
      sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    const area = Math.abs(sum / 2);
    if (area > bestArea) {
      bestArea = area;
      best = ring;
    }
  }
  let lon = 0;
  let lat = 0;
  const count = best.length - 1;
  for (let i = 0; i < count; i++) {
    lon += best[i][0];
    lat += best[i][1];
  }
  return { lon: lon / count, lat: lat / count };
}

export const inmetAnchorDegrees = alertAnchorDegrees;
