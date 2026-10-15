/**
 * barreto.top: Portuguese labels for the main chrome (panel titles, top
 * buttons, search) and a row of Brazilian cities in the LOCATION tray.
 * Static text only — live status lines stay as the app writes them.
 */
import * as Cesium from 'cesium';

/** Exact English text → Portuguese, for titles and labels. */
export const CHROME_TEXT = Object.freeze({
  'DATA LAYERS': 'Camadas',
  CCTV: 'Câmeras',
  'STREET LEVEL': 'Nível da rua',
  SCENES: 'Cenas',
  DISPLAY: 'Exibição',
  WEATHER: 'Tempo',
  'RECENT IMAGERY': 'Imagens recentes',
  CONTEXT: 'Contexto',
  RADIO: 'Rádio',
  'VISUAL PRESETS': 'Estilos',
  'MAP SOURCE': 'Fonte do mapa',
  LOCATION: 'Local',
  'BRASIL AGORA': 'Alertas do Brasil',
});

/** Visual style buttons: [label, tooltip]. */
export const STYLE_TEXT = Object.freeze({
  normal: ['Normal', 'Mapa sem filtro'],
  retro: ['TV antiga', 'Tela de tubo verde, com linhas'],
  surveillance: ['Noturna', 'Visão noturna, em verde'],
  thermal: ['Térmica', 'Cores de câmera térmica'],
  anime: ['Desenho', 'Cores vivas e contornos de desenho'],
  noir: ['P&B', 'Preto e branco com alto contraste'],
  snow: ['Neve', 'Cena fria, coberta de neve'],
});

/** id → [title/aria-label] for the top action buttons and search. */
const ATTRIBUTES = Object.freeze({
  'clear-selected-layers': [
    'Desligar todas as camadas ligadas',
    'Desligar todas as camadas',
  ],
  'share-btn': ['Copiar link desta visão (posição e camadas)', 'Copiar link'],
  'tilt-map-view': ['Alternar vista de cima e inclinada', 'Inclinar a vista'],
  'north-up-view': ['Apontar o mapa para o norte', 'Norte para cima'],
  'reset-globe-view': ['Voltar ao globo inteiro', 'Ver o globo inteiro'],
  'search-toggle': ['Buscar um lugar', 'Buscar um lugar'],
  'location-bar-toggle': ['Abrir LOCAL', 'Abrir LOCAL'],
});

/** Brazilian cities for the LOCATION tray: [name, lat, lon]. */
export const BRAZIL_CITIES = Object.freeze([
  ['São Paulo', -23.5505, -46.6333],
  ['Rio de Janeiro', -22.9068, -43.1729],
  ['Brasília', -15.7939, -47.8828],
  ['Belo Horizonte', -19.9167, -43.9345],
  ['Curitiba', -25.4284, -49.2733],
  ['Porto Alegre', -30.0346, -51.2177],
  ['Salvador', -12.9777, -38.5016],
  ['Recife', -8.0476, -34.877],
  ['Fortaleza', -3.7319, -38.5267],
  ['Belém', -1.4558, -48.4902],
  ['Manaus', -3.119, -60.0217],
  ['Cuiabá', -15.6014, -56.0979],
]);

function translateTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const key = node.nodeValue.trim();
    if (CHROME_TEXT[key]) hits.push([node, key]);
  }
  for (const [node, key] of hits)
    node.nodeValue = node.nodeValue.replace(key, CHROME_TEXT[key]);
}

export function translateChrome() {
  document
    .querySelectorAll(
      '.panel-title, .pp-header-label, #map-source-label, .location-toolbar-label',
    )
    .forEach(translateTextNodes);
  for (const [id, [title, aria]] of Object.entries(ATTRIBUTES)) {
    const node = document.getElementById(id);
    if (!node) continue;
    node.title = title;
    node.setAttribute('aria-label', aria);
  }
  // barreto.top branding: the product name the team uses. The original
  // project is credited in the "Como usar" guide.
  const titleText = document.querySelector('#title-bar h1 > span:last-child');
  if (titleText) titleText.textContent = 'ABC World View';
  const subtitle = document.querySelector('#title-bar .subtitle');
  if (subtitle) subtitle.textContent = 'Monitoramento em tempo real';
  const loaderTitle = document.querySelector('#loading-screen h2');
  if (loaderTitle) loaderTitle.textContent = 'ABC World View';
  for (const button of document.querySelectorAll('.style-btn[data-style]')) {
    const text = STYLE_TEXT[button.dataset.style];
    if (!text) continue;
    const label = button.querySelector('.btn-label');
    if (label) label.textContent = text[0];
    button.title = text[1];
  }
  document.title = 'ABC World View · Monitoramento';
  const search = document.getElementById('location-search');
  if (search) {
    search.placeholder = 'Buscar cidade, endereço ou coordenada…';
    search.setAttribute('aria-label', 'Buscar lugar por nome ou coordenada');
  }
  document
    .querySelectorAll('.panel-collapse-btn[title="Collapse panel"]')
    .forEach((button) => (button.title = 'Abrir ou fechar o painel'));
}

export function installBrazilCities({ styleManager, signal } = {}) {
  const popover = document.getElementById('location-bar-popover');
  if (!popover || document.getElementById('barreto-city-row')) return null;
  const row = document.createElement('div');
  row.id = 'barreto-city-row';
  row.className = 'barreto-city-row';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Cidades do Brasil');
  for (const [name, lat, lon] of BRAZIL_CITIES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'barreto-city';
    button.textContent = name;
    button.addEventListener('click', () => {
      const viewer = styleManager?.viewer;
      if (!viewer || viewer.isDestroyed?.()) return;
      viewer.camera.cancelFlight?.();
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat - 0.12, 14_000),
        orientation: {
          heading: 0,
          pitch: Cesium.Math.toRadians(-45),
          roll: 0,
        },
        duration: 3,
      });
    });
    row.append(button);
  }
  const pin = popover.querySelector('.dock-pin-btn');
  if (pin?.nextSibling) popover.insertBefore(row, pin.nextSibling);
  else popover.prepend(row);
  signal?.addEventListener('abort', () => row.remove());
  return row;
}

/**
 * Phones: the closed side panels (CENAS, EXIBIÇÃO, CÂMERAS, NÍVEL DA RUA,
 * CONTEXTO…) covered most of the map. Hide the closed ones behind a "Mais
 * painéis" button in the top bar; open panels always stay visible.
 */
export function installMobilePanelsToggle({ signal } = {}) {
  const nav = document.getElementById('top-center-actions');
  if (!nav || document.getElementById('barreto-more-panels')) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'barreto-more-panels';
  button.title = 'Mostrar mais painéis';
  button.setAttribute('aria-label', 'Mostrar mais painéis');
  button.setAttribute('aria-pressed', 'false');
  button.innerHTML =
    '<span class="material-symbols-outlined" aria-hidden="true">more_horiz</span>';
  button.addEventListener('click', () => {
    const on = document.body.classList.toggle('barreto-more-panels');
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? 'Esconder painéis extras' : 'Mostrar mais painéis';
  });
  nav.append(button);
  signal?.addEventListener('abort', () => {
    button.remove();
    document.body.classList.remove('barreto-more-panels');
  });
  return button;
}
