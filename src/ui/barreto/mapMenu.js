/**
 * barreto.top: press and hold on the map (right-click on a computer) for a
 * small menu about that spot: route there, alerts there, save the place,
 * copy the coordinates.
 */
import * as Cesium from 'cesium';
import {
  KIND_ICON,
  LEVEL_COLOR,
  fetchNear,
  sourcesText,
  untilText,
} from './alertsApi.js';
import { addFavorite, escapeHtml, reversePlace } from './places.js';

const HOLD_MS = 550;
const MOVE_PX = 10;

export function initMapMenu({ styleManager, routePlanner, signal } = {}) {
  const viewer = () => styleManager?.viewer;
  const menu = document.createElement('div');
  menu.id = 'barreto-mapmenu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.append(menu);

  let spot = null;
  let request = null;

  function pick(x, y) {
    const v = viewer();
    if (!v?.scene) return null;
    const rect = v.scene.canvas.getBoundingClientRect();
    const p = new Cesium.Cartesian2(x - rect.left, y - rect.top);
    let cart = null;
    try {
      const ray = v.camera.getPickRay(p);
      cart = ray ? v.scene.globe.pick(ray, v.scene) : null;
      if (!cart) cart = v.camera.pickEllipsoid(p, v.scene.globe.ellipsoid);
    } catch {
      cart = null;
    }
    if (!cart) return null;
    const c = Cesium.Cartographic.fromCartesian(cart);
    return {
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
    };
  }

  function close() {
    request?.abort();
    menu.hidden = true;
    menu.classList.remove('visible');
    spot = null;
  }

  function open(x, y, point) {
    request?.abort();
    request = new AbortController();
    const { signal: rs } = request;
    spot = { ...point, name: '' };
    const coords = `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
    menu.innerHTML = `
      <header><b class="barreto-mapmenu-name">Este ponto</b><small>${coords}</small></header>
      <button type="button" role="menuitem" data-act="route"><span class="material-symbols-outlined" aria-hidden="true">directions</span>Rota até aqui</button>
      <button type="button" role="menuitem" data-act="save"><span class="material-symbols-outlined" aria-hidden="true">star</span>Salvar em Meus lugares</button>
      <button type="button" role="menuitem" data-act="copy"><span class="material-symbols-outlined" aria-hidden="true">content_copy</span>Copiar coordenadas</button>
      <div class="barreto-mapmenu-alerts"><small>Vendo alertas aqui…</small></div>`;
    menu.hidden = false;
    // Place it next to the finger/cursor, inside the screen.
    const w = Math.min(300, window.innerWidth - 24);
    menu.style.width = `${w}px`;
    const h = menu.offsetHeight || 220;
    const left = Math.max(12, Math.min(x - w / 2, window.innerWidth - w - 12));
    const top =
      y + 16 + h < window.innerHeight - 80 ? y + 16 : Math.max(12, y - h - 16);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    requestAnimationFrame(() => menu.classList.add('visible'));
    try {
      navigator.vibrate?.(12);
    } catch {
      /* no haptics */
    }
    reversePlace(point.lat, point.lon, 'bairro', { signal: rs })
      .then((r) => {
        if (rs.aborted || !r?.label) return;
        spot.name = r.label;
        menu.querySelector('.barreto-mapmenu-name').textContent = r.label;
      })
      .catch(() => {});
    fetchNear(point.lat, point.lon, { signal: rs })
      .then((data) => {
        if (rs.aborted) return;
        const box = menu.querySelector('.barreto-mapmenu-alerts');
        box.innerHTML = data.riscos?.length
          ? data.riscos
              .slice(0, 4)
              .map(
                (r) =>
                  `<p><span class="material-symbols-outlined" aria-hidden="true" style="color:${LEVEL_COLOR[r.rank]}">${KIND_ICON[r.kind] || 'warning'}</span><span><b>${escapeHtml(r.label)} · ${escapeHtml(r.level)}</b><small>${escapeHtml([sourcesText(r.sources), untilText(r.until)].filter(Boolean).join(' · '))}</small></span></p>`,
              )
              .join('')
          : '<small class="ok">Nenhum alerta ativo aqui.</small>';
      })
      .catch(() => {
        const box = menu.querySelector('.barreto-mapmenu-alerts');
        if (box && !rs.aborted) box.textContent = '';
      });
  }

  menu.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act || !spot) return;
    const place = {
      lat: spot.lat,
      lon: spot.lon,
      name: spot.name || 'Ponto no mapa',
    };
    if (act === 'route') routePlanner?.setDestination(place);
    else if (act === 'save') {
      const name = globalThis.prompt?.(
        'Nome para este lugar (ex.: Casa, Trabalho):',
        spot.name || '',
      );
      if (name && name.trim()) await addFavorite(place, name.trim());
    } else if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(
          `${spot.lat.toFixed(6)}, ${spot.lon.toFixed(6)}`,
        );
      } catch {
        /* clipboard blocked */
      }
    }
    close();
  });

  // ---- press and hold (touch) / right click (mouse)
  let hold = null;
  const canvasOf = () => viewer()?.scene?.canvas;
  const onDown = (e) => {
    if (!menu.hidden && !menu.contains(e.target)) close();
    if (e.pointerType === 'mouse') {
      if (e.button === 2) hold = { x: e.clientX, y: e.clientY, mouse: true };
      return;
    }
    if (!e.isPrimary) {
      clearTimeout(hold?.timer);
      hold = null;
      return;
    }
    const start = { x: e.clientX, y: e.clientY };
    hold = {
      ...start,
      timer: setTimeout(() => {
        const point = pick(start.x, start.y);
        hold = null;
        if (point) open(start.x, start.y, point);
      }, HOLD_MS),
    };
  };
  const onMove = (e) => {
    if (!hold || hold.mouse) return;
    if (Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > MOVE_PX) {
      clearTimeout(hold.timer);
      hold = null;
    }
  };
  const onUp = () => {
    if (hold && !hold.mouse) {
      clearTimeout(hold.timer);
      hold = null;
    }
  };
  const onContext = (e) => {
    e.preventDefault();
    // Right-drag zooms in Cesium: only a still right click opens the menu.
    if (
      hold?.mouse &&
      Math.hypot(e.clientX - hold.x, e.clientY - hold.y) <= MOVE_PX
    ) {
      const point = pick(e.clientX, e.clientY);
      if (point) open(e.clientX, e.clientY, point);
    }
    hold = null;
  };

  function hook() {
    const canvas = canvasOf();
    if (!canvas) return false;
    canvas.addEventListener('pointerdown', onDown, { signal, capture: true });
    canvas.addEventListener('pointermove', onMove, { signal, capture: true });
    canvas.addEventListener('pointerup', onUp, { signal, capture: true });
    canvas.addEventListener('pointercancel', onUp, { signal, capture: true });
    canvas.addEventListener('contextmenu', onContext, { signal });
    viewer()?.camera?.moveStart?.addEventListener(() => {
      if (!menu.hidden) close();
    });
    return true;
  }
  if (!hook()) {
    const retry = setInterval(() => {
      if (hook() || signal?.aborted) clearInterval(retry);
    }, 1000);
    signal?.addEventListener('abort', () => clearInterval(retry));
  }
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && !menu.hidden) close();
    },
    { signal },
  );
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== canvasOf())
        close();
    },
    { signal },
  );
  signal?.addEventListener('abort', () => menu.remove());
  return { open, close };
}
