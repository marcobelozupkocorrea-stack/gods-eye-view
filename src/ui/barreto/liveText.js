/**
 * barreto.top: Portuguese for the status text the app writes at run time
 * (layer meta lines such as "INMET · 29s ago", loading chips, the location
 * mini status). Watches only a few containers and rewrites matching text
 * nodes in place; text it does not recognise is left alone.
 */

const PHRASES = Object.freeze({
  'just now': 'agora',
  never: 'nunca',
  'KEY REQUIRED': 'PRECISA DE CHAVE',
  LIVE: 'AO VIVO',
  OBSERVED: 'OBSERVADO',
  FORECAST: 'PREVISÃO',
  'LOADING LIVE DATA': 'CARREGANDO DADOS',
  'LOAD COMPLETE': 'PRONTO',
  'LOAD CANCELLED': 'CANCELADO',
  'LOAD FAILED': 'FALHA AO CARREGAR',
  'LIVE DATA OFF': 'CAMADAS DESLIGADAS',
  'TURNING OFF LIVE DATA': 'DESLIGANDO',
  'REFRESHING LIVE DATA': 'ATUALIZANDO DADOS',
  'MAPPED SITES LOADED': 'LOCAIS CARREGADOS',
  'FETCHING MAPPED SITES': 'BUSCANDO LOCAIS',
  'RETRYING MAPPED SITES': 'TENTANDO DE NOVO',
  'syncing road network': 'carregando vias',
  'loading frames': 'carregando imagens',
  'Landmark: --': 'Ponto: --',
  'Initializing photorealistic world...': 'Carregando o mapa…',
  'ACTIVE STYLE': 'ESTILO',
  // Layer source lines whose upstream names are wrong or opaque here.
  Flights: 'OpenSky / ADSB.lol',
  'Military aircraft': 'ADSB.lol (militares)',
  Vessels: 'AISStream',
  'CCTV + Street View fallback': 'DER-SP, CET-SP e câmeras públicas',
  'OpenStreetMap + optional Google Maps Places': 'OpenStreetMap',
  'OpenStreetMap / TomTom': 'OpenStreetMap + TomTom ao vivo',
  Local: 'OpenStreetMap (fixo)',
  USACE: 'OpenStreetMap / OpenInfraMap',
  'NOAA nowCOAST': 'NOAA',
  'Launch Library 2': 'Launch Library',
  // Weather panel ("Tempo"): cards, history slider and options.
  'Observed history': 'Histórico observado',
  'Satellite clouds': 'Nuvens por satélite',
  'Rain radar': 'Radar de chuva (EUA)',
  'Lightning density': 'Raios',
  'Lightning density · 15 min': 'Raios · 15 min',
  'Rain radar · US': 'Radar de chuva · EUA',
  Latest: 'Agora',
  LATEST: 'AGORA',
  'newest per product': 'imagem mais recente de cada camada',
  Play: 'Animar',
  Pause: 'Pausar',
  REGION: 'REGIÃO',
  IMAGE: 'IMAGEM',
  OPACITY: 'OPACIDADE',
  'Clouds only': 'Só nuvens',
  Full: 'Completa',
  Soft: 'Suave',
  Vivid: 'Forte',
  'View coverage': 'Ver cobertura',
  'Hide coverage': 'Ocultar cobertura',
  Observed: 'Observado',
  History: 'Histórico',
  Forecast: 'Previsão',
  synced: 'sincronizado',
  nearest: 'mais próxima',
  'Waiting for observation': 'Aguardando imagem',
  'Observation unavailable': 'Imagem indisponível',
  'Loading next frame…': 'Carregando a próxima imagem…',
  'Source observations delayed': 'Fonte atrasada',
  'Stale source': 'Fonte desatualizada',
  'Map center outside coverage': 'Centro do mapa fora da cobertura',
  'Frame unavailable; previous observation retained':
    'Imagem indisponível; mantendo a anterior',
  'Weather imagery unavailable': 'Imagens indisponíveis',
  'Weather tiles unavailable · previous frame retained':
    'Imagens indisponíveis · mantendo a anterior',
  'Some weather tiles unavailable': 'Parte das imagens indisponível',
  'Does not follow history': 'Não acompanha o histórico',
  'Global · 60°S–60°N': 'Global · 60°S–60°N',
  'North America': 'América do Norte',
  'Americas + Pacific': 'Américas + Pacífico',
});

const PATTERNS = Object.freeze([
  [/^(\d+)\s*s ago$/i, (_, n) => `há ${n} s`],
  [/^(\d+)\s*m(?:in)? ago$/i, (_, n) => `há ${n} min`],
  [/^(\d+)\s*h ago$/i, (_, n) => `há ${n} h`],
  [/^(\d+)\s*d ago$/i, (_, n) => `há ${n} dias`],
  [/^(\d+)h (\d+)m ago$/i, (_, h, m) => `há ${h} h ${m} min`],
  [/^(\d+) min ago$/i, (_, n) => `há ${n} min`],
  [
    /^No frame within (.+) of (.+)$/,
    (_, gap, at) => `Sem imagem a até ${gap} de ${at}`,
  ],
  [/^updated (.+)$/i, (_, rest) => `atualizado ${translatePart(rest)}`],
  [
    /^📍 Location: (.*)$/,
    (_, rest) => `📍 Local: ${rest === '--' ? '--' : rest}`,
  ],
  [/^Landmark: (.*)$/, (_, rest) => `Ponto: ${rest}`],
]);

function translatePart(part) {
  const trimmed = part.trim();
  if (!trimmed) return part;
  if (Object.hasOwn(PHRASES, trimmed))
    return part.replace(trimmed, PHRASES[trimmed]);
  for (const [re, fn] of PATTERNS) {
    const m = re.exec(trimmed);
    if (m) return part.replace(trimmed, fn(...m));
  }
  return part;
}

/** Translate one text value; " · "-separated meta lines go piece by piece. */
export function translateLiveText(text) {
  const value = String(text ?? '');
  if (!value.trim()) return value;
  const whole = translatePart(value);
  if (whole !== value) return whole;
  if (!value.includes(' · ')) return value;
  return value.split(' · ').map(translatePart).join(' · ');
}

function translateTree(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const next = translateLiveText(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
  }
}

export const LIVE_TEXT_ROOTS = Object.freeze([
  '#data-panel',
  '#global-loading-status',
  '#traffic-sync-chip',
  '#cctv-sync-chip',
  '#toast',
  '#location-mini-status',
  '#loading-screen',
  '#style-indicator',
  '#weather-panel',
]);

export function installLiveText({ signal } = {}) {
  const observers = [];
  let pending = new Set();
  let frame = 0;
  const flush = () => {
    frame = 0;
    const roots = pending;
    pending = new Set();
    for (const root of roots) if (root.isConnected) translateTree(root);
  };
  for (const selector of LIVE_TEXT_ROOTS) {
    const root = document.querySelector(selector);
    if (!root) continue;
    translateTree(root);
    const observer = new MutationObserver(() => {
      pending.add(root);
      if (!frame) frame = requestAnimationFrame(flush);
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    observers.push(observer);
  }
  signal?.addEventListener('abort', () => {
    for (const o of observers) o.disconnect();
    if (frame) cancelAnimationFrame(frame);
  });
}
