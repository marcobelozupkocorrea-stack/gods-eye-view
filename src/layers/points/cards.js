import { formatAreaKm2 } from '../../data/deter.js';

export const DETER_OVERLAY_SOURCE_ID = 'deter-alerts';
export const CEMADEN_OVERLAY_SOURCE_ID = 'cemaden-alerts';

const TIME_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const DATE_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const when = (ms) =>
  Number.isFinite(ms)
    ? TIME_FORMAT.format(new Date(ms)).replace(',', '')
    : null;
const day = (ms) =>
  Number.isFinite(ms) ? DATE_FORMAT.format(new Date(ms)) : null;
const place = (row) =>
  [row.municipality, row.uf].filter(Boolean).join('/') || null;

const cardBase = (id, title, details, accent) => ({
  id,
  selected: true,
  interactive: false,
  title,
  details: details.filter(Boolean),
  accent,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** Card for one DETER alert (Portuguese). */
export function buildDeterCard(row) {
  const area = formatAreaKm2(row.areaKm2);
  const seen = day(row.date);
  return cardBase(
    `deter-card:${row.stableId}`,
    `🌳 ${String(row.label || 'Alerta DETER').toUpperCase()}`,
    [
      [place(row), row.biome].filter(Boolean).join(' · '),
      [area, seen ? `visto em ${seen}` : null].filter(Boolean).join(' · '),
      row.protectedArea ? `Unidade de conservação: ${row.protectedArea}` : null,
      row.satellite
        ? `Satélite ${[row.satellite, row.sensor].filter(Boolean).join(' ')}`
        : null,
      'Fonte: INPE · DETER',
    ],
    row.color,
  );
}

/** Card for one Cemaden municipal alert (Portuguese, Brasília time). */
export function buildCemadenCard(row) {
  const since = when(row.created);
  const updated = when(row.updated);
  return cardBase(
    `cemaden-card:${row.stableId}`,
    `⚠ ${String(row.event || 'Alerta').toUpperCase()} · ${row.level}`,
    [
      place(row),
      [
        since ? `desde ${since}` : null,
        updated ? `atualizado ${updated}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      'Fonte: Cemaden',
    ],
    row.color,
  );
}

/** DETER point size grows with the cleared area (5–12 px). */
export const deterPixelSize = (row) =>
  5 + Math.min(7, Math.sqrt(Math.max(0, row.areaKm2 || 0)) * 5);

/** Cemaden point size grows with the alert level (11–15 px). */
export const cemadenPixelSize = (row) => 9 + 2 * (row.rank || 1);
