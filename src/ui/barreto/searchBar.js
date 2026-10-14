/**
 * barreto.top: search bar and "Você está vendo".
 *
 * - A search pill (like a maps app): type a place, street + number, CEP or a
 *   favourite; results come as you type (Brazil first). Pick one to fly there
 *   (city, bairro or state outlines are drawn), or use "Rota" / "★".
 * - Under it, the bairro / cidade / estado at the centre of the map, kept up
 *   to date as the camera moves, with "Limites" to draw that area's border.
 * - The old LOCAL tray search box opens this one.
 */
import * as Cesium from 'cesium';
import { attachPlaceInput } from './placeInput.js';
import {
  addFavorite,
  cameraView,
  flyToPlace,
  levelForHeight,
  reversePlace,
} from './places.js';

const OUTLINE_COLOR = '#39d0ff';
const LEVEL_WORD = { bairro: 'bairro', cidade: 'cidade', estado: 'estado' };

/** GeoJSON Polygon/MultiPolygon → outer rings of [lon, lat]. */
export function outerRings(geojson) {
  if (geojson?.type === 'Polygon')
    return [geojson.coordinates?.[0]].filter(Boolean);
  if (geojson?.type === 'MultiPolygon')
    return (geojson.coordinates || []).map((p) => p?.[0]).filter(Boolean);
  return [];
}

/** Which level a picked search result's outline should be. */
export function levelForResult(result) {
  const t = result?.type;
  if (t === 'state') return 'estado';
  if (t === 'city' || t === 'county') return 'cidade';
  if (t === 'district' || t === 'locality') return 'bairro';
  return null;
}

export function initSearchBar({ styleManager, routePlanner, signal } = {}) {
  const viewer = () => styleManager?.viewer || null;

  const bar = document.createElement('div');
  bar.id = 'barreto-searchbar';
  bar.className = 'barreto-searchbar';
  bar.innerHTML = `
    <div class="barreto-searchbar-pill">
      <span class="material-symbols-outlined" aria-hidden="true">search</span>
      <input type="search" enterkeyhint="search" autocomplete="off" spellcheck="false"
        placeholder="Buscar lugar, endereço ou CEP" aria-label="Buscar lugar, endereço ou CEP" />
      <button type="button" class="barreto-searchbar-route" title="Rota (com trânsito)" aria-label="Planejar rota">
        <span class="material-symbols-outlined" aria-hidden="true">directions</span>
      </button>
    </div>
    <div class="barreto-whereami" hidden>
      <span class="material-symbols-outlined" aria-hidden="true">my_location</span>
      <span class="barreto-whereami-text" aria-live="polite"></span>
      <button type="button" class="barreto-whereami-limits" aria-pressed="false" title="Desenhar os limites desta área">Limites</button>
    </div>`;
  document.body.append(bar);
  const input = bar.querySelector('input');
  const whereEl = bar.querySelector('.barreto-whereami');
  const whereText = bar.querySelector('.barreto-whereami-text');
  const limitsBtn = bar.querySelector('.barreto-whereami-limits');

  // ---------------------------------------------------------------- outline
  let outline = [];
  let pin = null;
  let outlineKey = '';
  function clearOutline() {
    const v = viewer();
    for (const e of outline) v?.entities?.remove(e);
    outline = [];
    outlineKey = '';
  }
  function drawOutline(record) {
    const v = viewer();
    const rings = outerRings(record?.polygon);
    if (!v || !rings.length) return false;
    const key = `${record.level}|${record.name}|${rings.length}`;
    if (key === outlineKey) return true;
    clearOutline();
    outlineKey = key;
    for (const ring of rings) {
      if (ring.length < 3) continue;
      outline.push(
        v.entities.add({
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(ring.flat()),
            width: 3,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString(OUTLINE_COLOR),
              dashLength: 18,
            }),
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
          },
        }),
      );
    }
    v.scene?.requestRender?.();
    return true;
  }
  function placePin(place) {
    const v = viewer();
    if (!v) return;
    if (pin) v.entities.remove(pin);
    pin = v.entities.add({
      position: Cesium.Cartesian3.fromDegrees(place.lon, place.lat, 0),
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString('#ff375f'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  // ---------------------------------------------------------------- search
  attachPlaceInput({
    input,
    getCenter: () => {
      const view = cameraView(viewer());
      return view && Number.isFinite(view.lat) ? view : null;
    },
    offerLocation: true,
    signal,
    actions: (place) =>
      place.myLocation
        ? []
        : [
            {
              id: 'route',
              icon: 'directions',
              label: 'Rota até aqui',
              short: 'Rota',
            },
            ...(place.favorite
              ? []
              : [
                  { id: 'save', icon: 'star', label: 'Salvar em Meus lugares' },
                ]),
          ],
    onAction: (id, place) => {
      if (id === 'route') routePlanner?.setDestination(place);
      if (id === 'save') {
        const name = globalThis.prompt?.(
          'Nome para este lugar (ex.: Casa, Trabalho):',
          place.name,
        );
        if (name && name.trim()) void addFavorite(place, name.trim());
      }
    },
    onPick: async (place) => {
      input.blur();
      flyToPlace(viewer(), place, { range: place.myLocation ? 1500 : 2500 });
      placePin(place);
      const level = levelForResult(place);
      if (level) {
        try {
          const record = await reversePlace(place.lat, place.lon, level, {
            polygon: true,
          });
          if (drawOutline(record)) {
            limitsBtn.setAttribute('aria-pressed', 'true');
            limitsOn = true;
          }
        } catch {
          /* outline is a nicety */
        }
      }
    },
  });
  bar
    .querySelector('.barreto-searchbar-route')
    .addEventListener('click', () => routePlanner?.toggle(), { signal });

  // The LOCAL tray's own box hands over to this one.
  const dockSearch = document.getElementById('location-search');
  if (dockSearch) {
    dockSearch.placeholder = 'Buscar lugar, endereço ou CEP…';
    dockSearch.addEventListener(
      'focus',
      () => {
        const text = dockSearch.value;
        dockSearch.blur();
        input.value = text;
        input.focus();
        if (text) input.dispatchEvent(new Event('input'));
      },
      { signal },
    );
  }

  // ---------------------------------------------------------------- where am I
  let limitsOn = false;
  let lastRecord = null;
  let timer = 0;
  let request = null;
  let lastKey = '';

  async function refreshWhere() {
    const v = viewer();
    const view = cameraView(v);
    const level = levelForHeight(view?.height);
    if (view && !level) {
      whereEl.hidden = false;
      const overBrazil =
        Number.isFinite(view.lat) &&
        view.lat > -34 &&
        view.lat < 5.5 &&
        view.lon > -74 &&
        view.lon < -34.5;
      whereText.textContent = overBrazil ? 'Brasil' : 'Visão do planeta';
      limitsBtn.hidden = true;
      lastKey = '';
      return;
    }
    if (!view || !Number.isFinite(view.lat)) return;
    const step = level === 'bairro' ? 0.01 : level === 'cidade' ? 0.05 : 0.5;
    const key = `${level}|${Math.round(view.lat / step)}|${Math.round(view.lon / step)}|${limitsOn}`;
    if (key === lastKey) return;
    lastKey = key;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    try {
      const record = await reversePlace(view.lat, view.lon, level, {
        polygon: limitsOn,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      lastRecord = record;
      whereEl.hidden = !record?.label;
      whereText.textContent = record?.label || '';
      whereText.title = `Você está vendo: ${record?.label || ''}`;
      limitsBtn.hidden = false;
      limitsBtn.textContent = `Limites do ${LEVEL_WORD[level]}`;
      if (limitsOn) drawOutline(record);
    } catch {
      if (!controller.signal.aborted) lastKey = '';
    }
  }

  limitsBtn.addEventListener(
    'click',
    async () => {
      limitsOn = !limitsOn;
      limitsBtn.setAttribute('aria-pressed', String(limitsOn));
      if (!limitsOn) {
        clearOutline();
        return;
      }
      lastKey = '';
      await refreshWhere();
      if (lastRecord?.polygon) drawOutline(lastRecord);
    },
    { signal },
  );

  let removeMoveEnd = null;
  function hook() {
    const v = viewer();
    if (!v?.camera?.moveEnd) return false;
    removeMoveEnd = v.camera.moveEnd.addEventListener(() => {
      clearTimeout(timer);
      timer = setTimeout(refreshWhere, 700);
    });
    timer = setTimeout(refreshWhere, 1500);
    return true;
  }
  if (!hook()) {
    const retry = setInterval(() => {
      if (hook() || signal?.aborted) clearInterval(retry);
    }, 1000);
    signal?.addEventListener('abort', () => clearInterval(retry));
  }

  signal?.addEventListener('abort', () => {
    removeMoveEnd?.();
    clearTimeout(timer);
    request?.abort();
    clearOutline();
    if (pin) viewer()?.entities?.remove(pin);
    bar.remove();
  });
  return {
    focus: () => input.focus(),
    clearOutline,
  };
}
