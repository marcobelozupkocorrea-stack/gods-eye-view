/**
 * @module firmsLabels
 * @description FIRMS-specific presentation formatting retained after the
 * dedicated card canvas moved into the shared world-overlay host.
 */

/** Shipped ambient FIRMS card ceiling. Selected fires bypass this cohort. */
export const FIRMS_AMBIENT_COHORT_LIMIT = 18;
export const FIRMS_OVERLAY_SOURCE_ID = 'firms';

/** Refetch-stable identity for one FIRMS detection, including its source feed. */
export function fireDetectionKey(fire) {
  const lat = Number.isFinite(fire?.lat) ? fire.lat.toFixed(4) : 'x';
  const lon = Number.isFinite(fire?.lon) ? fire.lon.toFixed(4) : 'x';
  const acq =
    Number.isFinite(fire?.acqMs) && fire.acqMs > 0 ? String(fire.acqMs) : '0';
  const source =
    satelliteShortName(fire?.satellite) ||
    String(fire?.sensor || '')
      .trim()
      .toUpperCase() ||
    'x';
  return `firms:${lat}:${lon}:${acq}:${source}`;
}

/** Severity accent palette — matches the FIRMS glow-sprite color stops. */
const ACCENT_RGB = Object.freeze({
  red: '224, 82, 82',
  orange: '240, 178, 62',
  yellow: '244, 227, 108',
});

/**
 * Severity stop name → "r, g, b" accent string (defaults to yellow).
 * @param {string} stopName - 'red' | 'orange' | 'yellow'.
 * @returns {string}
 */
export function accentForSeverity(stopName) {
  return ACCENT_RGB[stopName] || ACCENT_RGB.yellow;
}

/** Raw FIRMS satellite code → short display name (N = Suomi NPP). */
export function satelliteShortName(satellite) {
  const s = String(satellite || '')
    .trim()
    .toUpperCase();
  if (s === 'N20' || s === 'NOAA-20') return 'N20';
  if (s === 'N21' || s === 'NOAA-21') return 'N21';
  if (s === 'N' || s === 'NPP' || s === 'SUOMI NPP') return 'SNPP';
  // INPE (Brazil) satellite codes
  if (s === 'NPP-375') return 'SNPP';
  let m = /^GOES-(\d+)$/.exec(s);
  if (m) return `G${m[1]}`;
  m = /^METOP-([A-C])$/.exec(s);
  if (m) return `MetOp${m[1]}`;
  m = /^MSG-0?(\d+)$/.exec(s);
  if (m) return `MSG${m[1]}`;
  return s ? s.slice(0, 6) : '';
}

// ── INPE (Brazil) place details ─────────────────────────────────────────────

const UF_BY_STATE = Object.freeze({
  ACRE: 'AC',
  ALAGOAS: 'AL',
  AMAPÁ: 'AP',
  AMAZONAS: 'AM',
  BAHIA: 'BA',
  CEARÁ: 'CE',
  'DISTRITO FEDERAL': 'DF',
  'ESPÍRITO SANTO': 'ES',
  GOIÁS: 'GO',
  MARANHÃO: 'MA',
  'MATO GROSSO': 'MT',
  'MATO GROSSO DO SUL': 'MS',
  'MINAS GERAIS': 'MG',
  PARÁ: 'PA',
  PARAÍBA: 'PB',
  PARANÁ: 'PR',
  PERNAMBUCO: 'PE',
  PIAUÍ: 'PI',
  'RIO DE JANEIRO': 'RJ',
  'RIO GRANDE DO NORTE': 'RN',
  'RIO GRANDE DO SUL': 'RS',
  RONDÔNIA: 'RO',
  RORAIMA: 'RR',
  'SANTA CATARINA': 'SC',
  'SÃO PAULO': 'SP',
  SERGIPE: 'SE',
  TOCANTINS: 'TO',
});

const LOWER_WORDS = new Set(['da', 'de', 'do', 'das', 'dos', 'e', "d'"]);

/** "SÃO JOSÉ DO RIO PRETO" → "São José do Rio Preto". */
export function titleCasePt(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) =>
      i > 0 && LOWER_WORDS.has(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

/** Full Brazilian state name (any case) → UF code, or '' when unknown. */
export function ufForState(state) {
  return (
    UF_BY_STATE[
      String(state || '')
        .trim()
        .toUpperCase()
    ] || ''
  );
}

/**
 * INPE "risco de fogo" (0–1) → Portuguese class used by the Programa
 * Queimadas: mínimo, baixo, médio, alto, crítico. '' when absent.
 */
export function inpeFireRiskLabel(value) {
  if (value === '' || value === null || value === undefined) return '';
  const risk = Number(value);
  if (!Number.isFinite(risk) || risk < 0) return '';
  if (risk < 0.15) return 'mínimo';
  if (risk < 0.4) return 'baixo';
  if (risk < 0.7) return 'médio';
  if (risk < 0.95) return 'alto';
  return 'crítico';
}

/**
 * Card lines for an INPE fire's `place` ({municipio, estado, bioma,
 * riscoFogo, diasSemChuva}). Returns { where, context } strings, either of
 * which may be ''. `where` is "Coroatá/MA"; `context` is
 * "Cerrado · risco alto · 12 dias sem chuva".
 */
export function inpePlaceLines(place) {
  if (!place) return { where: '', context: '' };
  const city = titleCasePt(place.municipio);
  const uf = ufForState(place.estado);
  const where = city && uf ? `${city}/${uf}` : city || uf;
  const context = [];
  if (place.bioma) context.push(String(place.bioma).trim());
  const risk = inpeFireRiskLabel(place.riscoFogo);
  if (risk) context.push(`risco ${risk}`);
  const dry = Number(place.diasSemChuva);
  if (place.diasSemChuva !== '' && Number.isFinite(dry) && dry >= 0)
    context.push(`${dry} ${dry === 1 ? 'dia' : 'dias'} sem chuva`);
  return { where, context: context.join(' · ') };
}
