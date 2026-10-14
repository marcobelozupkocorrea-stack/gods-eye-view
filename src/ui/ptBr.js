/**
 * barreto.top: Portuguese (Brazil) labels for the layer panel.
 *
 * Translation is switched on by the page language (`<html lang="pt-BR">`),
 * so tests and the unmodified upstream page keep their English strings.
 * Only presentation text goes through here — layer ids, group keys and
 * share-link state stay in English.
 */

const GROUPS = Object.freeze({
  Movement: 'Movimento',
  Cameras: 'Câmeras',
  Infrastructure: 'Infraestrutura',
  Events: 'Eventos',
  Weather: 'Clima e alertas',
  Utilities: 'Utilidades',
  'Other layers': 'Outras camadas',
});

const LAYERS = Object.freeze({
  satellites: 'Satélites',
  flights: 'Voos ao vivo',
  military: 'Voos militares',
  'local-adsb': 'ADS-B local',
  'ais-live-vessels': 'Navios ao vivo',
  traffic: 'Trânsito',
  transit: 'Transporte público',
  bikeshare: 'Bicicletas compartilhadas',
  cctv: 'Câmeras públicas',
  'recent-imagery': 'Imagens recentes',
  'street-level': 'Fotos de rua',
  'alpr-cameras': 'Câmeras de placas (ALPR)',
  'military-installations': 'Instalações militares',
  'local-datacenters': 'Data centers',
  'telegeography-submarine-cables': 'Cabos submarinos',
  'local-dams': 'Barragens',
  'rocket-launches': 'Lançamentos espaciais',
  earthquakes: 'Terremotos',
  'local-firms': 'Focos de queimada',
  'fire-perimeters': 'Perímetros de incêndio (EUA)',
  'inmet-alerts': 'Alertas INMET',
  'defesa-civil-alerts': 'Alertas Defesa Civil',
  'deter-alerts': 'Desmatamento (DETER)',
  'cemaden-alerts': 'Alertas Cemaden',
  wind: 'Vento',
  'weather-radar': 'Radar de chuva (EUA)',
  'weather-satellite': 'Nuvens por satélite',
  'weather-lightning': 'Raios',
  'weather-cyclones': 'Ciclones',
  directions: 'Rotas',
  radio: 'Rádio',
});

const STATES = Object.freeze({
  ON: 'LIGADA',
  OFF: 'DESLIGADA',
  LOADING: 'CARREGANDO',
  DEGRADED: 'INSTÁVEL',
  STALE: 'DESATUALIZADA',
  PARTIAL: 'PARCIAL',
  FALLBACK: 'ALTERNATIVA',
  UNAVAILABLE: 'INDISPONÍVEL',
  UNCERTAIN: 'INCERTA',
  ENABLING: 'LIGANDO',
  DISABLING: 'DESLIGANDO',
});

/** True when the page declares a Portuguese language. */
export function isPortugueseUi(doc = globalThis.document) {
  try {
    return /^pt\b/i.test(String(doc?.documentElement?.lang || ''));
  } catch {
    return false;
  }
}

/** Panel group heading in the page language. */
export function groupLabel(label, doc) {
  return isPortugueseUi(doc) ? GROUPS[label] || label : label;
}

/** Panel row name for a layer id in the page language (null when unknown). */
export function layerLabel(id, doc) {
  return isPortugueseUi(doc) ? LAYERS[id] || null : null;
}

/** Toggle / status word (ON, LOADING…) in the page language. */
export function stateLabel(word, doc) {
  return isPortugueseUi(doc) ? STATES[word] || word : word;
}

/**
 * Layers a first visit opens with in the Portuguese build (no share link, no
 * saved preferences). Saved choices and share links always win.
 */
export const BRAZIL_FIRST_VISIT_LAYER_IDS = Object.freeze([
  'local-firms',
  'inmet-alerts',
  'defesa-civil-alerts',
  'cemaden-alerts',
  'cctv',
]);

/** First-visit layers for the page language ([] keeps upstream behaviour). */
export function firstVisitLayerIds(doc) {
  return isPortugueseUi(doc) ? [...BRAZIL_FIRST_VISIT_LAYER_IDS] : [];
}
