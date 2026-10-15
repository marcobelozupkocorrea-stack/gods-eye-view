/**
 * barreto.top: "Brasil agora" panel — every active Brazilian alert in one
 * list with source / severity / place filters. Tapping an item turns its
 * layer on, flies there and opens the item's card.
 */
import * as Cesium from 'cesium';
import {
  BRASIL_SOURCES,
  DEFAULT_SOURCES,
  SEVERITY_FILTERS,
  countBySource,
  filterBrasilItems,
  formatWhen,
  sortBrasilItems,
  toBrasilItems,
} from './brasilFeed.js';
import {
  createHistoryView,
  createNearCard,
  createPlacesView,
} from './alertsViews.js';

export const BRASIL_PANEL_ID = 'brasil-panel';
const PAGE = 30;
const REFRESH_MS = 5 * 60_000;

const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'className') node.className = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
};

const CACHE_KEY = 'barreto:alertas-cache:v1';
const readCache = () => {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(CACHE_KEY) || 'null');
    return v && Array.isArray(v.items) ? v : null;
  } catch {
    return null;
  }
};
const writeCache = (items) => {
  try {
    globalThis.localStorage?.setItem(
      CACHE_KEY,
      JSON.stringify({ at: Date.now(), items: items.slice(0, 400) }),
    );
  } catch {
    /* storage full or off */
  }
};

export function initBrasilPanel({
  styleManager,
  dataManager,
  notify,
  signal,
} = {}) {
  const panel = document.getElementById(BRASIL_PANEL_ID);
  const body = document.getElementById('brasil-panel-body');
  if (!panel || !body) return null;
  panel.hidden = false;

  const state = {
    sources: new Set(DEFAULT_SOURCES),
    minSeverity: 0,
    text: '',
    shown: PAGE,
    rows: {},
    fetchedAt: {},
    loading: new Set(),
    errors: new Set(),
  };

  const intro = el('p', {
    className: 'brasil-intro',
    text: 'Alertas ativos agora. Toque num item para ir até o local e ver os detalhes no mapa.',
  });
  const chips = el('div', {
    className: 'brasil-chips',
    role: 'group',
    'aria-label': 'Fontes de alerta',
  });
  const severity = el('select', {
    className: 'brasil-select',
    'aria-label': 'Gravidade mínima',
  });
  for (const option of SEVERITY_FILTERS)
    severity.append(
      el('option', { value: String(option.min), text: option.label }),
    );
  const search = el('input', {
    type: 'search',
    className: 'brasil-search',
    placeholder: 'Estado ou cidade (SP, Ubatuba…)',
    'aria-label': 'Filtrar por estado, cidade ou tipo de alerta',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const filters = el('div', { className: 'brasil-filters' }, [
    severity,
    search,
  ]);
  const status = el('p', {
    className: 'brasil-status',
    role: 'status',
    'aria-live': 'polite',
  });
  const list = el('ol', {
    className: 'brasil-list',
    'aria-label': 'Alertas ativos',
  });
  const more = el('button', {
    type: 'button',
    className: 'brasil-more',
    text: 'Mostrar mais',
    hidden: true,
  });
  // Tabs: the live list, the same alerts grouped by state/city, history.
  const near = createNearCard({ styleManager, signal });
  const places = createPlacesView({ styleManager, signal });
  const history = createHistoryView({ signal });
  const nowView = el('section', { className: 'al-now' }, [
    intro,
    chips,
    filters,
    status,
    list,
    more,
  ]);
  const tabs = el('div', {
    className: 'al-tabs',
    role: 'tablist',
    'aria-label': 'Ver alertas',
  });
  const TABS = [
    ['agora', 'Agora'],
    ['lugar', 'Lugares'],
    ['historico', 'Histórico'],
  ];
  let tab = 'agora';
  function setTab(next) {
    tab = next;
    for (const b of tabs.children)
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    nowView.hidden = tab !== 'agora';
    if (tab === 'lugar') places.show();
    else places.hide();
    if (tab === 'historico') history.show();
    else history.hide();
  }
  for (const [id, label] of TABS) {
    const b = el('button', {
      type: 'button',
      role: 'tab',
      className: 'al-tab',
      'data-tab': id,
      'aria-selected': String(id === tab),
      text: label,
    });
    b.addEventListener('click', () => setTab(id));
    tabs.append(b);
  }
  const bell = el(
    'button',
    {
      type: 'button',
      className: 'al-bell',
      title: 'Notificações de alertas',
      'aria-label': 'Notificações de alertas',
    },
    [
      el('span', {
        className: 'material-symbols-outlined',
        'aria-hidden': 'true',
        text: 'notifications',
      }),
      el('span', { text: 'Notificações' }),
    ],
  );
  bell.addEventListener('click', () => notify?.open?.());
  const offline = el('p', { className: 'al-offline', hidden: true });
  body.replaceChildren(
    el('div', { className: 'al-top' }, [tabs, bell]),
    near.el,
    offline,
    nowView,
    places.el,
    history.el,
  );
  const cached = readCache();

  const isOpen = () => !panel.classList.contains('collapsed');

  // Alert count on the panel header, visible even while it is closed.
  const badge = document.createElement('span');
  badge.className = 'brasil-badge';
  badge.hidden = true;
  panel.querySelector('.panel-title')?.after(badge);
  function updateBadge(all) {
    const selected = all.filter((item) => state.sources.has(item.source));
    const loaded = [...state.sources].some((key) => state.rows[key]);
    if (!loaded) {
      badge.hidden = true;
      return;
    }
    const max = selected.filter((item) => item.severity >= 3).length;
    badge.hidden = false;
    badge.textContent = selected.length.toLocaleString('pt-BR');
    badge.classList.toggle('hot', max > 0);
    badge.title = `${selected.length} alertas ativos${max ? `, ${max} no nível máximo` : ''}`;
  }

  async function load(sourceKey, { force = false } = {}) {
    const meta = BRASIL_SOURCES[sourceKey];
    if (!meta || state.loading.has(sourceKey)) return;
    if (
      !force &&
      state.rows[sourceKey] &&
      Date.now() - (state.fetchedAt[sourceKey] || 0) < REFRESH_MS
    )
      return;
    state.loading.add(sourceKey);
    render();
    try {
      const response = await fetch(meta.endpoint, {
        signal,
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      state.rows[sourceKey] = Array.isArray(payload?.rows) ? payload.rows : [];
      state.fetchedAt[sourceKey] = Date.now();
      state.errors.delete(sourceKey);
    } catch (error) {
      if (signal?.aborted) return;
      state.errors.add(sourceKey);
      console.warn('[brasil-agora]', sourceKey, error?.message || error);
    } finally {
      state.loading.delete(sourceKey);
      render();
    }
  }

  const loadSelected = (options) =>
    Promise.all([...state.sources].map((key) => load(key, options)));

  let lastCacheWrite = 0;
  function render() {
    const live = Object.keys(state.rows).length > 0;
    let all = toBrasilItems({
      inmet: state.rows.inmet,
      defesa: state.rows.defesa,
      cemaden: state.rows.cemaden,
      deter: state.rows.deter,
    });
    // Offline (or every source failed): show the last list this device saw.
    const useCache = !live && cached && state.errors.size > 0;
    if (useCache) all = cached.items;
    offline.hidden = !useCache;
    if (useCache)
      offline.textContent = `Sem conexão: mostrando a lista de ${formatWhen(cached.at)}.`;
    if (live && Date.now() - lastCacheWrite > 60_000) {
      lastCacheWrite = Date.now();
      writeCache(all);
    }
    const counts = countBySource(all);
    updateBadge(all);
    chips.replaceChildren(
      ...Object.entries(BRASIL_SOURCES).map(([key, meta]) => {
        const on = state.sources.has(key);
        const count = state.rows[key]
          ? counts[key].toLocaleString('pt-BR')
          : state.loading.has(key)
            ? '…'
            : '';
        const chip = el(
          'button',
          {
            type: 'button',
            className: `brasil-chip${on ? ' on' : ''}${state.errors.has(key) ? ' error' : ''}`,
            'aria-pressed': String(on),
            title: meta.long,
          },
          [
            el('span', {
              className: 'brasil-chip-icon',
              'aria-hidden': 'true',
              text: meta.icon,
            }),
            el('span', { text: meta.label }),
            count
              ? el('span', { className: 'brasil-chip-count', text: count })
              : null,
          ],
        );
        chip.addEventListener('click', () => {
          if (state.sources.has(key)) state.sources.delete(key);
          else {
            state.sources.add(key);
            void load(key);
          }
          state.shown = PAGE;
          render();
        });
        return chip;
      }),
    );

    const filtered = sortBrasilItems(
      filterBrasilItems(all, {
        sources: state.sources,
        minSeverity: state.minSeverity,
        text: state.text,
      }),
    );
    const visible = filtered.slice(0, state.shown);
    list.replaceChildren(...visible.map(renderItem));
    more.hidden = filtered.length <= visible.length;
    more.textContent = `Mostrar mais (${(filtered.length - visible.length).toLocaleString('pt-BR')})`;

    const loading = [...state.loading].map((k) => BRASIL_SOURCES[k].label);
    const failed = [...state.errors]
      .filter((k) => state.sources.has(k))
      .map((k) => BRASIL_SOURCES[k].label);
    const parts = [];
    if (!state.sources.size) parts.push('Escolha ao menos uma fonte acima.');
    else if (filtered.length)
      parts.push(
        `${filtered.length.toLocaleString('pt-BR')} alerta${filtered.length > 1 ? 's' : ''}`,
      );
    else if (!loading.length)
      parts.push(
        state.text
          ? 'Nenhum alerta com esse filtro.'
          : 'Nenhum alerta ativo nessas fontes.',
      );
    if (loading.length) parts.push(`carregando ${loading.join(', ')}…`);
    if (failed.length) parts.push(`sem resposta: ${failed.join(', ')}`);
    status.textContent = parts.join(' · ');
  }

  function renderItem(item) {
    const when = [
      item.when ? `desde ${formatWhen(item.when)}` : '',
      item.until ? `até ${formatWhen(item.until)}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const button = el(
      'button',
      {
        type: 'button',
        className: 'brasil-item',
        title: 'Ir até o local e abrir os detalhes',
      },
      [
        el('span', {
          className: 'brasil-dot',
          'aria-hidden': 'true',
          style: `--dot:${item.color}`,
        }),
        el('span', { className: 'brasil-item-text' }, [
          el('span', { className: 'brasil-item-title', text: item.title }),
          item.subtitle
            ? el('span', { className: 'brasil-item-sub', text: item.subtitle })
            : null,
          el('span', {
            className: 'brasil-item-meta',
            text: [BRASIL_SOURCES[item.source].label, item.detail, when]
              .filter(Boolean)
              .join(' · '),
          }),
        ]),
        el('span', {
          className: 'material-symbols-outlined brasil-go',
          'aria-hidden': 'true',
          text: 'my_location',
        }),
      ],
    );
    button.addEventListener('click', () => void focusItem(item, button));
    return el('li', {}, [button]);
  }

  async function focusItem(item, button) {
    button?.classList.add('busy');
    try {
      if (!dataManager?.isEnabled?.(item.layerId))
        await dataManager?.setEnabled?.(item.layerId, true, { origin: 'user' });
      const viewer = styleManager?.viewer;
      if (viewer && !viewer.isDestroyed?.()) {
        viewer.camera.cancelFlight?.();
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            item.lon,
            item.lat,
            item.altitude,
          ),
          orientation: {
            heading: 0,
            pitch: Cesium.Math.toRadians(-90),
            roll: 0,
          },
          duration: 2.2,
        });
      }
      // On a phone the panel covers half the screen: get it out of the way.
      if (window.matchMedia?.('(max-width: 720px)').matches)
        styleManager?.setPanelCollapsed?.(BRASIL_PANEL_ID, true, {
          explicit: true,
        });
      // The layer may still be loading its own copy: retry the selection.
      const layer = dataManager?.layers?.get?.(item.layerId)?.module;
      for (let attempt = 0; attempt < 25; attempt += 1) {
        if (signal?.aborted) return;
        if (layer?.focusById?.(item.stableId)) break;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    } finally {
      button?.classList.remove('busy');
    }
  }

  severity.addEventListener('change', () => {
    state.minSeverity = Number(severity.value) || 0;
    state.shown = PAGE;
    render();
  });
  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.text = search.value;
      state.shown = PAGE;
      render();
    }, 150);
  });
  // Keep the globe's keyboard shortcuts (1–7, H, F…) from firing while typing.
  search.addEventListener('keydown', (event) => event.stopPropagation());
  more.addEventListener('click', () => {
    state.shown += PAGE;
    render();
  });

  const observer = new MutationObserver(() => {
    if (isOpen()) void loadSelected();
  });
  observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
  // Refresh in the background too, so the header count stays current.
  const timer = setInterval(
    () => void loadSelected({ force: true }),
    REFRESH_MS,
  );
  const firstLoad = setTimeout(() => void loadSelected(), 4000);
  signal?.addEventListener('abort', () => clearTimeout(firstLoad));
  signal?.addEventListener('abort', () => {
    observer.disconnect();
    clearInterval(timer);
  });
  if (isOpen()) void loadSelected();
  render();

  // Refresh the "near you" card with the list.
  const nearTimer = setInterval(() => {
    if (isOpen()) void near.refresh();
  }, REFRESH_MS);
  signal?.addEventListener('abort', () => clearInterval(nearTimer));
  let nearLoaded = false;
  const nearObserver = new MutationObserver(() => {
    if (isOpen() && !nearLoaded) {
      nearLoaded = true;
      void near.refresh();
    }
  });
  nearObserver.observe(panel, { attributes: true, attributeFilter: ['class'] });
  signal?.addEventListener('abort', () => nearObserver.disconnect());
  if (isOpen()) {
    nearLoaded = true;
    void near.refresh();
  }

  /** Open an alert by its hub id ("defesa:…", "inmet:…", "cemaden:…"). */
  async function focusAlert(id) {
    setTab('agora');
    for (let i = 0; i < 40 && !signal?.aborted; i += 1) {
      const all = toBrasilItems({
        inmet: state.rows.inmet,
        defesa: state.rows.defesa,
        cemaden: state.rows.cemaden,
      });
      const item = all.find((x) => x.key === id);
      if (item) return focusItem(item);
      if (i === 0) void loadSelected();
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  return {
    open() {
      styleManager?.setPanelCollapsed?.(BRASIL_PANEL_ID, false, {
        explicit: true,
      });
      void loadSelected();
    },
    refresh: () => {
      void near.refresh();
      places.refresh();
      history.refresh();
      return loadSelected({ force: true });
    },
    focusAlert,
    showTab: setTab,
  };
}
