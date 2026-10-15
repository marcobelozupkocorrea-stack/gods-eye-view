/**
 * barreto.top: phone / installed-app shell.
 *
 * On a phone (or a phone on its side) the desktop chrome — a row of icons on
 * top, panels stacked down the left, two dock trays at the bottom — left little
 * room for the map and the trays did not fit the screen. Here it becomes an
 * app layout:
 *
 * - a bottom tab bar: Mapa · Alertas · Camadas · Rota · Mais;
 * - one bottom sheet at a time (drag the handle up for full height, down or
 *   the phone's Back to close);
 * - map buttons on the right: my location, 2D/3D and a compass that only
 *   shows when the map is rotated;
 * - "Mais": map styles, every other panel, share, install, help, sign out;
 * - offline notice, "new version" notice, and a refresh of the alerts when
 *   the app comes back after a while in the background.
 *
 * The desktop layout is untouched; everything is keyed on body.barreto-app.
 */
import { flyToBrazil } from '../../camera.js';
import { BRAZIL_CITIES } from './chrome.js';
import { searchPlaces } from './places.js';
import { mountViewsList } from './savedViews.js';
import { SHARE_PARAMS, parseShared, sharedFromUrl } from './shareTarget.js';
import { badgeCount, isNewerBuild, sheetSnap } from './appShellLogic.js';

export { badgeCount, isNewerBuild, sheetSnap };

export const APP_MEDIA_QUERY =
  '(max-width: 720px), (pointer: coarse) and (max-height: 520px)';

/** Panels in the right rail that "Mais" can open, in the order shown. */
export const MORE_PANELS = Object.freeze([
  ['weather-panel', 'rainy', 'Tempo e radar'],
  ['cctv-panel', 'videocam', 'Câmeras'],
  ['street-level-panel', 'streetview', 'Nível da rua'],
  ['recent-imagery-panel', 'satellite_alt', 'Imagens recentes'],
  ['global-context-panel', 'info', 'Contexto do lugar'],
  ['pp-toggles', 'tune', 'Exibição e efeitos'],
  ['scene-panel', 'view_in_ar', 'Cenas'],
]);

const TABS = Object.freeze([
  ['mapa', 'map', 'Mapa'],
  ['brasil', 'warning', 'Alertas'],
  ['camadas', 'layers', 'Camadas'],
  ['rota', 'directions', 'Rota'],
  ['mais', 'menu', 'Mais'],
]);

const vibrate = (ms = 8) => {
  try {
    globalThis.navigator?.vibrate?.(ms);
  } catch {
    /* no haptics */
  }
};

const icon = (name) =>
  `<span class="material-symbols-outlined" aria-hidden="true">${name}</span>`;

export function initAppShell({
  styleManager,
  brasilPanel,
  routePlanner,
  searchBar,
  help,
  notify,
  timeline,
  signal,
} = {}) {
  const viewer = () => styleManager?.viewer || null;
  const body = document.body;
  const media = globalThis.matchMedia?.(APP_MEDIA_QUERY);
  const landscape = globalThis.matchMedia?.('(orientation: landscape)');
  const cleanups = [];
  const on = (target, type, fn, options = {}) =>
    target?.addEventListener(type, fn, { signal, ...options });

  // ------------------------------------------------------------- tab bar
  const tabbar = document.createElement('nav');
  tabbar.id = 'barreto-tabbar';
  tabbar.setAttribute('aria-label', 'Navegação principal');
  tabbar.innerHTML = TABS.map(
    ([id, glyph, label]) => `
    <button type="button" class="barreto-tab" data-tab="${id}" aria-pressed="${id === 'mapa'}">
      <span class="barreto-tab-icon">${icon(glyph)}${id === 'brasil' ? '<span class="barreto-tab-badge" hidden></span>' : ''}</span>
      <span class="barreto-tab-label">${label}</span>
    </button>`,
  ).join('');

  // ------------------------------------------------------------- map buttons
  const fabs = document.createElement('div');
  fabs.id = 'barreto-map-fabs';
  fabs.innerHTML = `
    <button type="button" class="barreto-fab barreto-fab-compass" hidden title="Apontar para o norte" aria-label="Apontar o mapa para o norte">
      <span class="barreto-compass-needle" aria-hidden="true"><i></i><b>N</b></span>
    </button>
    <button type="button" class="barreto-fab barreto-fab-tilt" title="Alternar 2D / 3D" aria-label="Alternar vista de cima e inclinada"><span class="barreto-fab-text">3D</span></button>
    <button type="button" class="barreto-fab barreto-fab-locate" title="Minha localização" aria-label="Ir para a minha localização">${icon('my_location')}</button>`;
  const compassBtn = fabs.querySelector('.barreto-fab-compass');
  const needle = fabs.querySelector('.barreto-compass-needle');
  const tiltBtn = fabs.querySelector('.barreto-fab-tilt');
  const tiltText = fabs.querySelector('.barreto-fab-text');
  const locateBtn = fabs.querySelector('.barreto-fab-locate');

  // ------------------------------------------------------------- sheet grip
  const grip = document.createElement('div');
  grip.id = 'barreto-sheet-grip';
  grip.setAttribute('role', 'button');
  grip.setAttribute('tabindex', '0');
  grip.setAttribute(
    'aria-label',
    'Arraste para cima para ampliar ou para baixo para fechar',
  );
  grip.innerHTML = '<span></span>';

  // ------------------------------------------------------------- "Mais"
  const more = document.createElement('section');
  more.id = 'barreto-more';
  more.className = 'barreto-app-sheet';
  more.hidden = true;
  more.setAttribute('aria-label', 'Mais opções');
  more.innerHTML = `
    <div class="barreto-more-scroll">
      <h2 class="barreto-more-h">Estilo do mapa</h2>
      <div class="barreto-more-styles" role="group" aria-label="Estilo visual"></div>
      <div class="barreto-more-sources" role="group" aria-label="Fonte do mapa"></div>
      <h2 class="barreto-more-h">Ir para</h2>
      <div class="barreto-more-cities" role="group" aria-label="Cidades">
        <button type="button" class="barreto-chip" data-go="brasil">${icon('zoom_out_map')}Brasil inteiro</button>
        <button type="button" class="barreto-chip" data-go="globo">${icon('public')}Planeta</button>
        ${BRAZIL_CITIES.map(([name], i) => `<button type="button" class="barreto-chip" data-city="${i}">${name}</button>`).join('')}
      </div>
      <h2 class="barreto-more-h">Minhas visões</h2>
      <div class="barreto-more-views"></div>
      <h2 class="barreto-more-h">Painéis</h2>
      <div class="barreto-more-grid barreto-more-panels"></div>
      <h2 class="barreto-more-h">Ações</h2>
      <div class="barreto-more-grid barreto-more-actions">
        <button type="button" data-act="share">${icon('share')}<span>Compartilhar esta visão</span></button>
        <button type="button" data-act="clear">${icon('layers_clear')}<span>Desligar todas as camadas</span></button>
        <button type="button" data-act="refresh">${icon('refresh')}<span>Atualizar alertas</span></button>
        <button type="button" data-act="install" hidden>${icon('install_mobile')}<span>Instalar o app</span></button>
        <button type="button" data-act="timeline">${icon('history')}<span>Linha do tempo (3 h)</span></button>
        <button type="button" data-act="notify">${icon('notifications')}<span>Notificações de alertas</span></button>
        <button type="button" data-act="help">${icon('help')}<span>Como usar</span></button>
        <button type="button" data-act="reload">${icon('restart_alt')}<span>Recarregar o app</span></button>
        <a href="/oauth2/sign_out" data-act="logout">${icon('logout')}<span>Sair da conta</span></a>
      </div>
      <p class="barreto-more-ios" hidden>${icon('ios_share')} No iPhone: toque em <b>Compartilhar</b> → <b>Adicionar à Tela de Início</b> para usar como app.</p>
    </div>`;

  // ------------------------------------------------------------- notices
  const notice = document.createElement('div');
  notice.id = 'barreto-app-notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;

  document.body.append(fabs, grip, more, tabbar, notice);

  // ------------------------------------------------------------- state
  let active = 'mapa'; // tab id, or 'panel:<id>'
  let full = false;
  let pushed = false;
  let enabled = false;

  const leftStack = () => document.getElementById('left-panel-stack');
  const rightRail = () => document.getElementById('right-context-rail');
  const panelFor = (tab) =>
    tab === 'brasil'
      ? 'brasil-panel'
      : tab === 'camadas'
        ? 'data-panel'
        : tab.startsWith('panel:')
          ? tab.slice(6)
          : null;

  function setPanel(id, open) {
    try {
      if (open && id === 'brasil-panel' && brasilPanel?.open)
        brasilPanel.open();
      else
        styleManager?.setPanelCollapsed?.(id, !open, {
          explicit: true,
          persist: false,
        });
    } catch {
      /* the panel may not exist in this build */
    }
    if (open) {
      // Some panels ignore the call while hidden; make sure it is expanded.
      const el = document.getElementById(id);
      if (el?.classList.contains('collapsed'))
        el.querySelector(`[data-collapse-target="${id}"]`)?.click();
    }
  }

  function markPanel(id) {
    for (const el of document.querySelectorAll('.barreto-sheet-panel'))
      if (el.id !== id) el.classList.remove('barreto-sheet-panel');
    for (const host of [leftStack(), rightRail()])
      host?.classList.remove('barreto-sheet-host');
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('barreto-sheet-panel');
    el.parentElement?.classList.add('barreto-sheet-host');
  }

  function render() {
    for (const b of tabbar.querySelectorAll('.barreto-tab')) {
      const tab = b.dataset.tab;
      const isOn =
        tab === active || (tab === 'mais' && active.startsWith('panel:'));
      b.setAttribute('aria-pressed', String(isOn));
    }
    const sheetOpen = active !== 'mapa';
    body.classList.toggle('barreto-sheet-open', enabled && sheetOpen);
    body.classList.toggle('barreto-sheet-full', enabled && sheetOpen && full);
    body.style.setProperty('--barreto-sheet-drag', '0px');
    more.hidden = active !== 'mais';
  }

  function open(tab, { history: useHistory = true } = {}) {
    if (!enabled) return;
    if (tab === active) {
      if (tab !== 'mapa') close();
      return;
    }
    const previous = active;
    const prevPanel = panelFor(previous);
    if (prevPanel) setPanel(prevPanel, false);
    if (previous === 'rota' && tab !== 'rota') routePlanner?.hide?.();
    active = tab;
    full = false;
    const panel = panelFor(tab);
    markPanel(panel);
    if (panel) setPanel(panel, true);
    if (tab === 'rota') routePlanner?.show?.();
    if (tab === 'mais') syncMore();
    if (tab !== 'mapa' && previous === 'mapa' && useHistory && !pushed) {
      try {
        globalThis.history?.pushState({ barretoSheet: true }, '');
        pushed = true;
      } catch {
        /* history unavailable */
      }
    }
    if (tab === 'mapa') unwindHistory();
    render();
    vibrate();
  }

  function unwindHistory() {
    if (!pushed) return;
    pushed = false;
    // The share link rewrites the current entry's state (replaceState), so
    // the flag, not history.state, says whether our entry is still on top.
    try {
      globalThis.history?.back();
    } catch {
      /* ignore */
    }
  }

  function close() {
    if (active === 'mapa') return;
    const panel = panelFor(active);
    if (active === 'rota') routePlanner?.hide?.();
    active = 'mapa';
    full = false;
    if (panel) setPanel(panel, false);
    markPanel(null);
    unwindHistory();
    render();
  }

  on(tabbar, 'click', (event) => {
    const b = event.target.closest('.barreto-tab');
    if (!b) return;
    const tab = b.dataset.tab;
    if (tab === 'mapa') close();
    else open(tab);
  });

  // The phone's Back button closes the sheet instead of leaving the app.
  on(globalThis, 'popstate', () => {
    // Our own history.back() after closing the details card.
    if (ignorePop) {
      ignorePop = false;
      return;
    }
    // The details card sits on top: Back closes it first.
    if (detailsPushed) {
      detailsPushed = false;
      closeDetails();
      return;
    }
    if (!pushed) return;
    pushed = false;
    if (active !== 'mapa') close();
  });

  // ---- details card: drag handle, swipe down and Back close it
  let detailsPushed = false;
  let ignorePop = false;
  const detailsEl = () => document.getElementById('barreto-details');
  const closeDetails = () =>
    detailsEl()?.querySelector('.barreto-details-close')?.click();
  function hookDetails() {
    const d = detailsEl();
    if (!d || d.dataset.barretoSheet) return !!d;
    d.dataset.barretoSheet = '1';
    const handle = document.createElement('div');
    handle.className = 'barreto-details-grip';
    handle.innerHTML = '<span></span>';
    d.prepend(handle);
    new MutationObserver(() => {
      if (!enabled) return;
      if (!d.hidden && !detailsPushed) {
        try {
          globalThis.history?.pushState({ barretoDetails: true }, '');
          detailsPushed = true;
        } catch {
          /* ignore */
        }
      } else if (d.hidden && detailsPushed) {
        detailsPushed = false;
        try {
          ignorePop = true;
          globalThis.history.back();
        } catch {
          /* ignore */
        }
      }
    }).observe(d, { attributes: true, attributeFilter: ['hidden'] });
    let start = null;
    const down = (e) => {
      if (!enabled) return;
      if (!e.target.closest('.barreto-details-grip, .barreto-details-header'))
        return;
      if (e.target.closest('button, a')) return;
      start = { y: e.clientY, t: performance.now() };
      d.setPointerCapture?.(e.pointerId);
      d.classList.add('dragging');
    };
    const move = (e) => {
      if (!start) return;
      const dy = Math.max(0, e.clientY - start.y);
      d.style.transform = `translateY(${dy}px)`;
    };
    const up = (e) => {
      if (!start) return;
      const dy = e.clientY - start.y;
      const v = dy / Math.max(1, performance.now() - start.t);
      start = null;
      d.classList.remove('dragging');
      d.style.transform = '';
      if (dy > 80 || v > 0.6) closeDetails();
    };
    d.addEventListener('pointerdown', down, { signal });
    d.addEventListener('pointermove', move, { signal });
    d.addEventListener('pointerup', up, { signal });
    d.addEventListener('pointercancel', up, { signal });
    return true;
  }
  if (!hookDetails()) {
    const retry = setInterval(() => {
      if (hookDetails() || signal?.aborted) clearInterval(retry);
    }, 1000);
    cleanups.push(() => clearInterval(retry));
  }

  // Panels closed from inside (their own button, or picking an alert, which
  // flies to it) close the sheet too; so does the route panel's own ✕.
  const watch = new MutationObserver(() => {
    if (!enabled) return;
    const panel = panelFor(active);
    if (panel) {
      const el = document.getElementById(panel);
      if (!el || el.classList.contains('collapsed') || el.hidden) close();
    }
    if (active === 'rota' && document.getElementById('barreto-route')?.hidden)
      close();
    else if (
      active !== 'rota' &&
      document.getElementById('barreto-route')?.hidden === false
    ) {
      // Opened from elsewhere ("Rota até aqui" in the search).
      const prevPanel = panelFor(active);
      if (prevPanel) setPanel(prevPanel, false);
      markPanel(null);
      const wasMap = active === 'mapa';
      active = 'rota';
      full = false;
      if (wasMap && !pushed) {
        try {
          globalThis.history?.pushState({ barretoSheet: true }, '');
          pushed = true;
        } catch {
          /* ignore */
        }
      }
      render();
    }
  });
  const observeTargets = () => {
    for (const id of [
      'brasil-panel',
      'data-panel',
      'barreto-route',
      ...MORE_PANELS.map(([id]) => id),
    ]) {
      const el = document.getElementById(id);
      if (el && !el.dataset.barretoWatched) {
        el.dataset.barretoWatched = '1';
        watch.observe(el, {
          attributes: true,
          attributeFilter: ['class', 'hidden'],
        });
      }
    }
  };
  observeTargets();
  cleanups.push(() => watch.disconnect());

  // ------------------------------------------------------------- dragging
  let drag = null;
  on(grip, 'pointerdown', (event) => {
    drag = {
      y: event.clientY,
      t: performance.now(),
      lastY: event.clientY,
      lastT: performance.now(),
      v: 0,
    };
    grip.setPointerCapture?.(event.pointerId);
    body.classList.add('barreto-sheet-dragging');
  });
  on(grip, 'pointermove', (event) => {
    if (!drag) return;
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastT);
    drag.v = (event.clientY - drag.lastY) / dt;
    drag.lastY = event.clientY;
    drag.lastT = now;
    const dy = event.clientY - drag.y;
    // Up only stretches a little: the snap does the rest.
    const shown = dy < 0 ? Math.max(dy, full ? 0 : -80) / (full ? 1 : 2) : dy;
    body.style.setProperty('--barreto-sheet-drag', `${Math.round(shown)}px`);
  });
  const endDrag = (event) => {
    if (!drag) return;
    const dy = event.clientY - drag.y;
    const moved = Math.abs(dy) > 6;
    const snap = moved ? sheetSnap(dy, full, drag.v) : full ? 'half' : 'full';
    drag = null;
    body.classList.remove('barreto-sheet-dragging');
    if (snap === 'close') close();
    else {
      full = snap === 'full';
      render();
    }
    vibrate(6);
  };
  on(grip, 'pointerup', endDrag);
  on(grip, 'pointercancel', endDrag);
  on(grip, 'keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      full = !full;
      render();
    } else if (event.key === 'Escape') close();
  });
  on(document, 'keydown', (event) => {
    if (event.key === 'Escape' && enabled && active !== 'mapa') {
      const tag = event.target?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') close();
    }
  });

  // ------------------------------------------------------------- map buttons
  let lastHeading = null;
  let lastTilted = null;
  function updateFabs() {
    const camera = viewer()?.camera;
    if (!camera || !enabled) return;
    const heading = (camera.heading * 180) / Math.PI;
    const h = ((heading % 360) + 360) % 360;
    const rotated = h > 1.5 && h < 358.5;
    if (lastHeading === null || Math.abs(h - lastHeading) > 0.8) {
      needle.style.transform = `rotate(${-h}deg)`;
      lastHeading = h;
    }
    if (compassBtn.hidden === rotated) compassBtn.hidden = !rotated;
    const tilted = (camera.pitch * 180) / Math.PI > -75;
    if (tilted !== lastTilted) {
      lastTilted = tilted;
      tiltText.textContent = tilted ? '2D' : '3D';
      tiltBtn.title = tilted ? 'Ver de cima (2D)' : 'Inclinar a vista (3D)';
    }
  }
  let removePostRender = null;
  function hookCamera() {
    const scene = viewer()?.scene;
    if (!scene?.postRender) return false;
    removePostRender = scene.postRender.addEventListener(updateFabs);
    updateFabs();
    return true;
  }
  if (!hookCamera()) {
    const retry = setInterval(() => {
      if (hookCamera() || signal?.aborted) clearInterval(retry);
    }, 1000);
    cleanups.push(() => clearInterval(retry));
  }
  cleanups.push(() => removePostRender?.());

  const clickById = (id) => document.getElementById(id)?.click();
  on(compassBtn, 'click', () => {
    clickById('north-up-view');
    vibrate();
  });
  on(tiltBtn, 'click', () => {
    clickById('tilt-map-view');
    vibrate();
  });
  on(locateBtn, 'click', () => {
    const geo = globalThis.navigator?.geolocation;
    if (!geo) return showNotice('Este aparelho não informa a localização.');
    locateBtn.classList.add('busy');
    geo.getCurrentPosition(
      (pos) => {
        locateBtn.classList.remove('busy');
        close();
        searchBar?.showPlace?.({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          name: 'Minha localização',
          myLocation: true,
        });
      },
      () => {
        locateBtn.classList.remove('busy');
        showNotice(
          'Não foi possível pegar a localização. Verifique a permissão do app.',
        );
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    );
  });

  // ------------------------------------------------------------- "Mais"
  cleanups.push(
    mountViewsList(more.querySelector('.barreto-more-views'), {
      styleManager,
      onApplied: () => close(),
    }),
  );
  const stylesBox = more.querySelector('.barreto-more-styles');
  const sourcesBox = more.querySelector('.barreto-more-sources');
  const panelsBox = more.querySelector('.barreto-more-panels');
  const installBtn = more.querySelector('[data-act="install"]');
  const iosHint = more.querySelector('.barreto-more-ios');

  /** Mirror buttons (label, icon, state) and forward clicks to the originals. */
  function mirror(box, originals, label, extraClass) {
    box.textContent = '';
    for (const original of originals) {
      const text = label(original);
      if (!text) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = extraClass;
      const iconHtml = original.querySelector('.btn-icon')?.innerHTML;
      b.innerHTML = `${iconHtml ? `<span class="barreto-style-icon" aria-hidden="true">${iconHtml}</span>` : ''}<span>${text}</span>`;
      const isActive =
        original.classList.contains('active') ||
        original.getAttribute('aria-pressed') === 'true' ||
        original.getAttribute('aria-checked') === 'true';
      b.setAttribute('aria-pressed', String(isActive));
      b.disabled = original.disabled;
      b.addEventListener('click', () => {
        original.click();
        vibrate();
        requestAnimationFrame(syncMore);
        setTimeout(syncMore, 1200);
      });
      box.append(b);
    }
  }
  const clean = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .trim();

  // "BING AERIAL" + small "ION" badge → "Bing Aerial · ion".
  const sourceLabel = (b) => {
    const parts = [];
    const walk = (n) => {
      if (n.nodeType === 3) parts.push(n.textContent);
      else if (n.nodeType === 1) {
        const before = parts.length;
        for (const c of n.childNodes) walk(c);
        if (n !== b && parts.length > before) parts.push(' ');
      }
    };
    walk(b);
    const words = clean(parts.join(' ')).split(' ');
    return words
      .map((w, i) => (i > 0 && /^ion$/i.test(w) ? '· ion' : w))
      .join(' ');
  };

  function syncMore() {
    mirror(
      stylesBox,
      document.querySelectorAll('#style-buttons .style-btn'),
      (b) => clean(b.querySelector('.btn-label')?.textContent || b.textContent),
      'barreto-style',
    );
    mirror(
      sourcesBox,
      document.querySelectorAll('.map-source-section button'),
      (b) => sourceLabel(b),
      'barreto-chip barreto-source',
    );
    panelsBox.textContent = '';
    for (const [id, glyph, label] of MORE_PANELS) {
      const el = document.getElementById(id);
      if (!el || el.hidden) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `${icon(glyph)}<span>${label}</span>`;
      b.addEventListener('click', () => open(`panel:${id}`));
      panelsBox.append(b);
    }
    observeTargets();
  }

  on(more, 'click', (event) => {
    const go = event.target.closest('[data-go], [data-city]');
    if (go) {
      const v = viewer();
      if (!v) return;
      close();
      if (go.dataset.go === 'brasil') flyToBrazil(v);
      else if (go.dataset.go === 'globo') clickById('reset-globe-view');
      else {
        const city = BRAZIL_CITIES[Number(go.dataset.city)];
        if (city)
          searchBar?.showPlace?.(
            { lat: city[1], lon: city[2], name: city[0] },
            { range: 14_000, pin: false },
          );
      }
      return;
    }
    const act = event.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'share') {
      close();
      if (globalThis.navigator?.share) {
        globalThis.navigator
          .share({ title: 'Barreto', url: globalThis.location.href })
          .catch(() => {});
      } else clickById('share-btn');
    } else if (act === 'clear') {
      clickById('clear-selected-layers');
      showNotice('Camadas desligadas.');
    } else if (act === 'refresh') {
      close();
      brasilPanel?.refresh?.();
      showNotice('Atualizando os alertas…');
    } else if (act === 'timeline') {
      close();
      void timeline?.open?.();
    } else if (act === 'notify') {
      close();
      notify?.open?.();
    } else if (act === 'help') {
      close();
      help?.open?.();
    } else if (act === 'reload') globalThis.location.reload();
    else if (act === 'install') void promptInstall();
  });

  // Install: Chrome / Edge / Android give a prompt; iPhone needs the menu.
  let installPrompt = null;
  const standalone = () =>
    globalThis.matchMedia?.('(display-mode: standalone)')?.matches ||
    globalThis.navigator?.standalone === true;
  on(globalThis, 'beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    installBtn.hidden = false;
  });
  on(globalThis, 'appinstalled', () => {
    installPrompt = null;
    installBtn.hidden = true;
    showNotice('App instalado. Abra pelo ícone "Barreto".');
  });
  async function promptInstall() {
    if (!installPrompt) return;
    installPrompt.prompt();
    try {
      await installPrompt.userChoice;
    } finally {
      installPrompt = null;
      installBtn.hidden = true;
    }
  }
  const ua = globalThis.navigator?.userAgent || '';
  iosHint.hidden = !(/iPhone|iPad|iPod/.test(ua) && !standalone());

  // ------------------------------------------------------------- badge
  const tabBadge = tabbar.querySelector('.barreto-tab-badge');
  const source = () => document.querySelector('#brasil-panel .brasil-badge');
  function syncBadge() {
    const b = source();
    const text = b && !b.hidden ? badgeCount(b.textContent) : '';
    tabBadge.hidden = !text;
    tabBadge.textContent = text;
    tabBadge.classList.toggle('hot', !!b?.classList.contains('hot'));
  }
  const badgeWatch = new MutationObserver(syncBadge);
  const hookBadge = () => {
    const b = source();
    if (!b) return false;
    badgeWatch.observe(b, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    syncBadge();
    return true;
  };
  if (!hookBadge()) {
    const retry = setInterval(() => {
      if (hookBadge() || signal?.aborted) clearInterval(retry);
    }, 1500);
    cleanups.push(() => clearInterval(retry));
  }
  cleanups.push(() => badgeWatch.disconnect());

  // ------------------------------------------------------------- notices
  let noticeTimer = 0;
  function showNotice(text, { sticky = false, action = null } = {}) {
    clearTimeout(noticeTimer);
    notice.textContent = '';
    const span = document.createElement('span');
    span.textContent = text;
    notice.append(span);
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', action.run);
      notice.append(b);
    }
    notice.hidden = false;
    notice.classList.toggle('sticky', sticky);
    if (!sticky)
      noticeTimer = setTimeout(() => {
        notice.hidden = true;
      }, 3500);
  }
  const hideNotice = () => {
    clearTimeout(noticeTimer);
    notice.hidden = true;
  };

  on(globalThis, 'offline', () =>
    showNotice('Sem internet. O mapa mostra só o que já foi carregado.', {
      sticky: true,
    }),
  );
  on(globalThis, 'online', () => {
    hideNotice();
    showNotice('Conexão de volta.');
    brasilPanel?.refresh?.();
  });
  if (globalThis.navigator?.onLine === false)
    showNotice('Sem internet. O mapa mostra só o que já foi carregado.', {
      sticky: true,
    });

  // Back from the background after a while: refresh alerts and look for a
  // newer version of the site (an installed app can stay open for days).
  let hiddenAt = 0;
  let lastVersionCheck = Date.now();
  const currentBundle = document.querySelector(
    'script[type="module"][src*="/assets/"]',
  )?.src;
  async function checkVersion() {
    if (!currentBundle || Date.now() - lastVersionCheck < 20 * 60_000) return;
    lastVersionCheck = Date.now();
    try {
      const res = await fetch('/', {
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'manual',
      });
      if (!res.ok || res.redirected || res.type !== 'basic') return;
      if (isNewerBuild(await res.text(), currentBundle))
        showNotice('Nova versão disponível.', {
          sticky: true,
          action: {
            label: 'Atualizar',
            run: () => globalThis.location.reload(),
          },
        });
    } catch {
      /* offline or signed out: try later */
    }
  }
  on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    if (hiddenAt && Date.now() - hiddenAt > 5 * 60_000)
      brasilPanel?.refresh?.();
    hiddenAt = 0;
    void checkVersion();
  });

  // ------------------------------------------------------------- typing
  on(document, 'focusin', (event) => {
    if (!enabled) return;
    const t = event.target;
    if (t?.matches?.('#barreto-searchbar input')) {
      if (active !== 'mapa' && active !== 'rota') close();
      body.classList.add('barreto-typing');
    }
  });
  on(document, 'focusout', () => body.classList.remove('barreto-typing'));

  // ------------------------------------------------------------- shortcuts
  // Home-screen shortcuts open the app at /?abrir=rota|alertas|camadas|busca;
  // a notification adds &alerta=<id> to open that alert.
  function openFromUrl(href = globalThis.location.href, delay = 1200) {
    let what = null;
    let alerta = null;
    let shared = null;
    try {
      const url = new URL(href, globalThis.location.href);
      what = url.searchParams.get('abrir');
      alerta = url.searchParams.get('alerta');
      shared = sharedFromUrl(url.href);
      if (href === globalThis.location.href && (what || alerta || shared)) {
        url.searchParams.delete('abrir');
        url.searchParams.delete('alerta');
        for (const p of Object.values(SHARE_PARAMS)) url.searchParams.delete(p);
        globalThis.history?.replaceState(
          globalThis.history.state,
          '',
          url.pathname + url.search + url.hash,
        );
      }
    } catch {
      return;
    }
    if (shared) {
      setTimeout(() => void openShared(shared), delay);
      return;
    }
    if (!what && !alerta) return;
    const run = () => {
      if (what === 'busca') searchBar?.focus?.();
      else if (what === 'rota') {
        if (enabled) open('rota');
        else routePlanner?.show?.();
      } else if (what === 'alertas' || what === 'brasil' || alerta) {
        if (enabled) {
          if (active !== 'brasil') open('brasil');
        } else brasilPanel?.open?.();
        if (alerta) void brasilPanel?.focusAlert?.(alerta);
      } else if (what === 'camadas') {
        if (enabled) open('camadas');
        else setPanel('data-panel', true);
      }
    };
    setTimeout(run, delay);
  }

  /** A link, address or coordinates shared to the app → route there. */
  async function openShared(shared) {
    let target = parseShared(shared);
    try {
      if (target?.resolve) {
        const res = await fetch(
          `/api/br/link?u=${encodeURIComponent(target.resolve)}`,
          { credentials: 'same-origin' },
        );
        const body = res.ok ? await res.json() : null;
        target =
          parseShared({ title: target.name, url: body?.url || '' }) || target;
      }
      if (target?.query) {
        const [hit] = await searchPlaces(target.query, null);
        if (hit) target = { ...hit, name: target.name || hit.name };
      }
    } catch {
      /* fall through to the search box */
    }
    if (Number.isFinite(target?.lat) && Number.isFinite(target?.lon)) {
      routePlanner?.setDestination?.({
        lat: target.lat,
        lon: target.lon,
        name: target.name || 'Lugar compartilhado',
      });
      showNotice(`Rota até ${target.name || 'o lugar compartilhado'}.`);
      return;
    }
    showNotice('Não achei um endereço no que foi compartilhado.');
    searchBar?.focus?.();
  }

  // A tapped notification while the app is already open.
  on(globalThis.navigator?.serviceWorker, 'message', (event) => {
    if (event.data?.type === 'barreto:open' && event.data.url)
      openFromUrl(event.data.url, 50);
  });

  // ------------------------------------------------------------- mode
  function apply() {
    const want = !!media?.matches;
    body.classList.toggle(
      'barreto-landscape',
      want && !!landscape?.matches && globalThis.innerWidth > 560,
    );
    if (want === enabled) return;
    if (!want && active !== 'mapa') close();
    enabled = want;
    body.classList.toggle('barreto-app', enabled);
    body.classList.toggle('barreto-standalone', !!standalone());
    if (enabled) syncMore();
    render();
  }
  apply();
  on(media, 'change', apply);
  on(landscape, 'change', apply);
  openFromUrl();

  signal?.addEventListener('abort', () => {
    for (const fn of cleanups) fn();
    clearTimeout(noticeTimer);
    markPanel(null);
    for (const cls of [
      'barreto-app',
      'barreto-landscape',
      'barreto-standalone',
      'barreto-sheet-open',
      'barreto-sheet-full',
      'barreto-typing',
    ])
      body.classList.remove(cls);
    for (const el of [fabs, grip, more, tabbar, notice]) el.remove();
  });

  return {
    open,
    close,
    get active() {
      return active;
    },
    get enabled() {
      return enabled;
    },
    showNotice,
  };
}
