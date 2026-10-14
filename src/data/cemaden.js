/**
 * barreto.top: Cemaden municipal risk alerts (hydrological risk and mass
 * movement) from the public alert panel (painelalertas.cemaden.gov.br).
 */

export const CEMADEN_LEVELS = Object.freeze({
  Moderado: { color: '#ffd60a', rank: 1 },
  Alto: { color: '#ff9f0a', rank: 2 },
  'Muito Alto': { color: '#ff3b30', rank: 3 },
});

const titleCase = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (m, pre, ch) => pre + ch.toUpperCase())
    .replace(/\b(Da|Das|De|Do|Dos|E)\b/g, (w) => w.toLowerCase());

/** "2026-10-02 11:25:51.874" (Brasília wall clock) → epoch ms. */
export function cemadenTimeMs(value) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(
    String(value || ''),
  );
  return m ? Date.parse(`${m[1]}T${m[2]}-03:00`) : NaN;
}

/** "Risco Hidrológico - Alto" → "Risco Hidrológico". */
export function cemadenEventKind(event) {
  return String(event || '')
    .replace(/\s*-\s*(Muito Alto|Alto|Moderado)\s*$/i, '')
    .trim();
}

/** Panel payload `{alertas:[...]}` → active point rows, most severe first. */
export function parseCemadenAlerts(payload) {
  const list = Array.isArray(payload?.alertas) ? payload.alertas : [];
  const rows = [];
  for (const a of list) {
    if (Number(a?.status) !== 1) continue;
    const lat = Number(a.latitude);
    const lon = Number(a.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -34.5 || lat > 6 || lon < -74.5 || lon > -32) continue;
    const id = String(a.cod_alerta ?? '').replace(/\D/g, '');
    if (!id) continue;
    const level = CEMADEN_LEVELS[a.nivel] ? a.nivel : 'Moderado';
    rows.push({
      stableId: `cemaden-${id}`,
      lat,
      lon,
      event: cemadenEventKind(a.evento) || 'Alerta',
      level,
      color: CEMADEN_LEVELS[level].color,
      rank: CEMADEN_LEVELS[level].rank,
      municipality: titleCase(a.municipio),
      uf: String(a.uf || '').toUpperCase(),
      created: cemadenTimeMs(a.datahoracriacao),
      updated: cemadenTimeMs(a.ult_atualizacao),
    });
  }
  return rows.sort(
    (a, b) => b.rank - a.rank || (b.updated || 0) - (a.updated || 0),
  );
}
