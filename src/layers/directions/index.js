/**
 * @module layers/directions
 * @description Keyless A→B directions on the globe: drive, walk or cycle.
 *
 * The row's chips arm a click ("SET A", then click the globe; "SET B", click
 * again). With both ends placed the layer asks the existing `/api/route`
 * proxy (OSRM on the FOSSGIS servers, © OpenStreetMap contributors) for the
 * street-following route with turn-by-turn steps, drapes it on the terrain
 * and 3D tiles with the same flowing dashes the voice "route from A to B"
 * annotation uses, and drops one dot per maneuver. Click a dot for the
 * instruction; "FLY" rides the camera along the route through the shared
 * route-flight cinematic (`flyRoute`), the way voice's `fly_route` does.
 *
 * Needs no key, no geocoder and no microphone. A route that cannot be found
 * says so — there is never a straight-line stand-in drawn as if it were a
 * route.
 */

import * as Cesium from 'cesium';
import {
  formatRouteDistance,
  formatRouteDuration,
} from '../../data/routeSteps.js';

export const DIRECTIONS_STEP_OVERLAY_SOURCE_ID = 'directions-step';
export const DIRECTIONS_STEP_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

/** Travel modes, keyed by the `/api/route` profile name. */
export const DIRECTIONS_MODES = Object.freeze({
  car: Object.freeze({ chip: 'DRIVE', word: 'Drive', icon: '🚗' }),
  foot: Object.freeze({ chip: 'WALK', word: 'Walk', icon: '🚶' }),
  bike: Object.freeze({ chip: 'BIKE', word: 'Bike', icon: '🚲' }),
});
export const DEFAULT_DIRECTIONS_MODE = 'car';
/** barreto.top: intermediate stops allowed between A and B. */
export const MAX_STOPS = 10;

/**
 * barreto.top: Portuguese copy, chosen per call from the page language so the
 * pure helpers stay English wherever there is no Portuguese document (tests,
 * upstream pages).
 */
export const isPortugueseDirections = () => {
  try {
    return /^pt\b/i.test(globalThis.document?.documentElement?.lang || '');
  } catch {
    return false;
  }
};
const PT_MODES = Object.freeze({
  car: Object.freeze({ chip: 'CARRO', word: 'Carro' }),
  foot: Object.freeze({ chip: 'A PÉ', word: 'A pé' }),
  bike: Object.freeze({ chip: 'BICICLETA', word: 'Bicicleta' }),
});

/** Traffic colour by TomTom magnitudeOfDelay (1 minor … 4 closed). */
export const DIRECTIONS_TRAFFIC_COLORS = Object.freeze({
  1: '#ffd23f',
  2: '#ff8c1a',
  3: '#ff3b30',
  4: '#8b0000',
});
export function trafficColor(magnitude, category) {
  if (category === 'ROAD_CLOSURE') return DIRECTIONS_TRAFFIC_COLORS[4];
  return DIRECTIONS_TRAFFIC_COLORS[Math.min(4, Math.max(1, magnitude || 2))];
}

export const INCIDENT_SYMBOLS = Object.freeze({
  accident: Object.freeze({ glyph: '💥', color: '#ff3b30' }),
  roadwork: Object.freeze({ glyph: '🚧', color: '#ff9500' }),
  closure: Object.freeze({ glyph: '⛔', color: '#8b0000' }),
  weather: Object.freeze({ glyph: '🌧', color: '#0a84ff' }),
  hazard: Object.freeze({ glyph: '⚠', color: '#ffcc00' }),
});

/** "17:45" from an ISO time with offset, in the page's local clock. */
export function clockTime(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Deep links that hand the route to a navigation app on the phone. */
export function navigationAppUrl(app, a, b, mode = 'car') {
  if (!b) return null;
  const dest = `${b.lat.toFixed(6)},${b.lon.toFixed(6)}`;
  if (app === 'waze')
    return `https://waze.com/ul?ll=${encodeURIComponent(dest)}&navigate=yes`;
  const travel =
    mode === 'foot' ? 'walking' : mode === 'bike' ? 'bicycling' : 'driving';
  const origin = a ? `&origin=${a.lat.toFixed(6)},${a.lon.toFixed(6)}` : '';
  return `https://www.google.com/maps/dir/?api=1${origin}&destination=${dest}&travelmode=${travel}`;
}

/** Route colour — the annotation palette's cyan, so voice routes and Directions match. */
export const DIRECTIONS_ROUTE_COLOR = '#39d0ff';
const MARKER_A_COLOR = Cesium.Color.fromCssColorString('#5dff9f');
const MARKER_B_COLOR = Cesium.Color.fromCssColorString('#ff6b6b');
const STEP_COLOR = Cesium.Color.WHITE.withAlpha(0.95);
const STEP_OUTLINE = Cesium.Color.fromCssColorString(DIRECTIONS_ROUTE_COLOR);
const STEP_PIXEL_SIZE = 8;
const STEP_SELECTED_PIXEL_SIZE = 13;
/** Route request timeout (ms) — the proxy itself gives OSRM 12 s. */
const ROUTE_TIMEOUT_MS = 15_000;

/** Pointer-ownership id while a globe click is placing an endpoint. */
export const DIRECTIONS_POINTER_OWNER = 'directions';

/**
 * How long to keep re-reading the shared ground floor for a maneuver dot whose
 * cell has not answered yet. The terrain proxy behind that floor can take tens
 * of seconds on a cold cache, so this is a wall-clock budget comfortably past
 * it rather than a handful of quick retries — a dot that resolves late still
 * appears. Reroute, CLEAR, disable and destroy all cancel it.
 */
export const STEP_ANCHOR_DEADLINE_MS = 90_000;
/** Gap between the first re-reads (ms); it widens after the first few. */
export const STEP_ANCHOR_RETRY_MS = 400;
/** Gap once the quick re-reads have not settled it (ms). */
export const STEP_ANCHOR_SLOW_RETRY_MS = 2000;
/** Re-reads at the quick gap before backing off. */
export const STEP_ANCHOR_FAST_ATTEMPTS = 5;
/** How often the row repaints the highlighted step while FLY is running (ms). */
export const FLIGHT_PROGRESS_MS = 250;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Validate a params patch. Returns null when it contains an unknown mode.
 * @param {object} params
 * @returns {{mode?: string, arm?: 'a'|'b'|null, swap?: boolean, fly?: boolean, clear?: boolean}|null}
 */
export function normalizeDirectionsParams(params = {}) {
  const out = {};
  if (params.mode !== undefined) {
    const mode = String(params.mode).toLowerCase();
    if (!DIRECTIONS_MODES[mode]) return null;
    out.mode = mode;
  }
  if (params.arm !== undefined) {
    out.arm =
      params.arm === 'a' || params.arm === 'b' || params.arm === 'stop'
        ? params.arm
        : null;
  }
  if (params.swap === true) out.swap = true;
  if (params.avoidTolls !== undefined)
    out.avoidTolls = params.avoidTolls === true;
  if (params.route !== undefined)
    out.route =
      Number.isInteger(params.route) && params.route >= 0 ? params.route : null;
  if (params.here === true) out.here = true;
  // barreto.top: whole itineraries (search, favourites): A, stops…, B.
  if (Array.isArray(params.points)) {
    const points = params.points
      .map((p) => ({
        lat: Number(p?.lat),
        lon: Number(p?.lon),
        label: typeof p?.label === 'string' ? p.label.slice(0, 80) : '',
      }))
      .filter(
        (p) =>
          Number.isFinite(p.lat) &&
          Number.isFinite(p.lon) &&
          Math.abs(p.lat) <= 90 &&
          Math.abs(p.lon) <= 180,
      );
    if (points.length >= 1 && points.length <= MAX_STOPS + 2)
      out.points = points;
  }
  if (params.depart !== undefined)
    out.depart =
      typeof params.depart === 'string' &&
      Number.isFinite(Date.parse(params.depart))
        ? params.depart
        : null;
  if (Number.isInteger(params.removeStop) && params.removeStop >= 0)
    out.removeStop = params.removeStop;
  if (params.clearStops === true) out.clearStops = true;
  if (params.refresh === true) out.refresh = true;
  if (params.fly === true) out.fly = true;
  if (params.clear === true) out.clear = true;
  if (params.step !== undefined) {
    out.step =
      Number.isInteger(params.step) && params.step >= 0 ? params.step : null;
  }
  return out;
}

/**
 * Row chips for a given state. Pure so the chip logic is testable without a DOM.
 * @param {{mode:string, armed:null|'a'|'b', a:object|null, b:object|null, status:string, route:object|null}} state
 * @returns {{chips: object[], legend: object[]}}
 */
export function directionsRowControls(state) {
  const { mode, armed, a, b, status, route, selectedStep, flightStep } = state;
  const pt = isPortugueseDirections();
  const routing = status === 'routing';
  const chips = Object.entries(DIRECTIONS_MODES).map(([id, spec]) => {
    const copy = pt ? PT_MODES[id] : spec;
    return {
      id: `mode-${id}`,
      label: copy.chip,
      active: mode === id,
      state: mode === id ? 'active' : 'idle',
      title: pt
        ? `${copy.word} — refazer a rota`
        : `${spec.word} — reroute for ${spec.word.toLowerCase()}`,
      params: { mode: id },
    };
  });
  const placed = pt ? ' ✓' : ' ✓';
  chips.push({
    id: 'set-a',
    label:
      armed === 'a'
        ? pt
          ? 'TOQUE NO MAPA'
          : 'CLICK MAP'
        : a
          ? pt
            ? `ORIGEM${placed}`
            : 'A ✓'
          : pt
            ? 'ORIGEM'
            : 'SET A',
    active: armed === 'a',
    state: armed === 'a' ? 'active' : 'idle',
    title: pt
      ? armed === 'a'
        ? 'Toque num ponto do mapa para a origem (toque de novo para cancelar)'
        : 'Depois toque no mapa para marcar a origem'
      : armed === 'a'
        ? 'Click a spot on the globe to place A (click again to cancel)'
        : 'Then click the globe to place the start',
    params: { arm: armed === 'a' ? null : 'a' },
  });
  if (pt && state.canLocate !== false)
    chips.push({
      id: 'here',
      label: state.locating ? 'LOCALIZANDO…' : 'DAQUI',
      busy: Boolean(state.locating),
      state: state.locating ? 'loading' : 'idle',
      title: 'Usar a sua localização atual como origem',
      params: { here: true },
    });
  chips.push({
    id: 'set-b',
    label:
      armed === 'b'
        ? pt
          ? 'TOQUE NO MAPA'
          : 'CLICK MAP'
        : b
          ? pt
            ? `DESTINO${placed}`
            : 'B ✓'
          : pt
            ? 'DESTINO'
            : 'SET B',
    active: armed === 'b',
    state: armed === 'b' ? 'active' : 'idle',
    title: pt
      ? armed === 'b'
        ? 'Toque num ponto do mapa para o destino (toque de novo para cancelar)'
        : 'Depois toque no mapa para marcar o destino'
      : armed === 'b'
        ? 'Click a spot on the globe to place B (click again to cancel)'
        : 'Then click the globe to place the destination',
    params: { arm: armed === 'b' ? null : 'b' },
  });
  const stops = Array.isArray(state.stops) ? state.stops : [];
  if (pt && a && b) {
    chips.push({
      id: 'add-stop',
      label:
        armed === 'stop'
          ? 'TOQUE NO MAPA'
          : `+ PARADA${stops.length ? ` (${stops.length})` : ''}`,
      active: armed === 'stop',
      state: armed === 'stop' ? 'active' : 'idle',
      disabled: stops.length >= MAX_STOPS || routing,
      title:
        stops.length >= MAX_STOPS
          ? `No máximo ${MAX_STOPS} paradas`
          : 'Toque no mapa para incluir uma parada no caminho',
      params: { arm: armed === 'stop' ? null : 'stop' },
    });
    if (stops.length)
      chips.push({
        id: 'clear-stops',
        label: 'TIRAR PARADAS',
        state: 'idle',
        disabled: routing,
        title: 'Remover todas as paradas intermediárias',
        params: { clearStops: true },
      });
  }
  chips.push({
    id: 'swap',
    label: '⇄',
    disabled: !(a && b) || routing,
    state: 'idle',
    title: pt ? 'Inverter origem e destino' : 'Swap A and B',
    params: { swap: true },
  });
  if (pt && mode === 'car')
    chips.push({
      id: 'tolls',
      label: 'SEM PEDÁGIO',
      active: Boolean(state.avoidTolls),
      state: state.avoidTolls ? 'active' : 'idle',
      disabled: routing,
      title: state.avoidTolls
        ? 'Evitando pedágios — toque para permitir'
        : 'Calcular a rota evitando pedágios',
      params: { avoidTolls: !state.avoidTolls },
    });
  const options = Array.isArray(state.routes) ? state.routes : [];
  if (options.length > 1)
    options.forEach((option, index) => {
      chips.push({
        id: `route-${index}`,
        label: `${pt ? 'ROTA' : 'ROUTE'} ${index + 1} · ${formatRouteDuration(option.durationS)}`,
        active: index === (state.routeIndex ?? 0),
        state: index === (state.routeIndex ?? 0) ? 'active' : 'idle',
        disabled: routing,
        title: pt
          ? `${formatRouteDistance(option.distanceM)}${option.traffic?.delayS >= 60 ? ` · +${formatRouteDuration(option.traffic.delayS)} de trânsito` : ''}`
          : formatRouteDistance(option.distanceM),
        params: { route: index },
      });
    });
  const flying = Number.isInteger(flightStep);
  chips.push({
    id: 'fly',
    label: pt
      ? routing
        ? 'SOBREVOAR ···'
        : flying
          ? 'SOBREVOANDO'
          : 'SOBREVOAR'
      : routing
        ? 'FLY ···'
        : flying
          ? 'FLYING'
          : 'FLY',
    disabled: !route || routing,
    busy: routing || flying,
    active: flying,
    state: routing || flying ? 'loading' : 'idle',
    title: pt
      ? route
        ? 'Levar a câmera pelo caminho'
        : 'Marque origem e destino primeiro'
      : route
        ? 'Fly the camera along the route'
        : 'Place A and B first',
    params: { fly: true },
  });
  if (pt && b) {
    for (const [app, label] of [
      ['waze', 'ABRIR NO WAZE'],
      ['google', 'GOOGLE MAPS'],
    ]) {
      const href = navigationAppUrl(app, a, b, mode);
      chips.push({
        id: `open-${app}`,
        label,
        state: 'idle',
        title:
          app === 'waze'
            ? 'Navegar até o destino com o Waze (voz e GPS)'
            : 'Abrir a rota no Google Maps',
        onClick: () => {
          try {
            globalThis.open?.(href, '_blank', 'noopener');
          } catch {
            /* popup blocked */
          }
        },
      });
    }
  }
  chips.push({
    id: 'clear',
    label: pt ? 'LIMPAR' : 'CLEAR',
    disabled: !a && !b && !route,
    state: 'idle',
    title: pt
      ? 'Apagar a rota e os marcadores'
      : 'Remove the route and both markers',
    params: { clear: true },
  });
  return {
    chips,
    legend:
      pt && route?.congestion?.length
        ? [
            { label: 'Fluindo', color: DIRECTIONS_ROUTE_COLOR },
            { label: 'Lento', color: DIRECTIONS_TRAFFIC_COLORS[1] },
            { label: 'Congestionado', color: DIRECTIONS_TRAFFIC_COLORS[2] },
            { label: 'Parado', color: DIRECTIONS_TRAFFIC_COLORS[3] },
          ]
        : [],
    list: directionsStepList({
      route,
      selectedStep: selectedStep ?? null,
      flightStep: flightStep ?? null,
    }),
  };
}

/**
 * Plain names for the tools that can be holding the pointer, and how to leave
 * each one. A tool missing from here still gets a usable sentence from its id.
 */
export const POINTER_TOOL_EXITS = Object.freeze({
  draw: Object.freeze({
    name: 'Draw',
    leave: 'press Escape twice to leave Draw',
  }),
});

/**
 * What to say when a globe click cannot be armed because something else owns
 * the pointer.
 *
 * The claim failing used to be silent: the chip simply did not light and the
 * operator was left to guess which of the open tools was eating the click
 * (owner field test — he thought Directions was broken). So the message names
 * the tool and says how to put it down. Pure.
 * @param {string|null} owner Current pointer-owner id.
 * @param {'a'|'b'} which Endpoint that was being armed.
 * @returns {string|null} Toast text, or null when nothing holds the pointer.
 */
export function pointerBlockedMessage(owner, which) {
  const id = typeof owner === 'string' ? owner.trim() : '';
  if (!id || id === DIRECTIONS_POINTER_OWNER) return null;
  const endpoint = which === 'b' ? 'B' : 'A';
  const known = POINTER_TOOL_EXITS[id];
  const name = known?.name || id;
  const leave = known?.leave || `turn ${name} off`;
  return `${name} is active — ${leave}, then set ${endpoint}`;
}

/**
 * Which maneuvers get a dot on the globe: every one except departure and
 * arrival, which the A and B markers already stand for.
 * @param {object[]} steps
 * @returns {number[]} Step indices.
 */
export function stepMarkerIndices(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const out = [];
  for (let index = 1; index < list.length - 1; index += 1) out.push(index);
  return out;
}

/**
 * Render height for a maneuver dot.
 *
 * A dot fixed at a couple of metres ellipsoidal is at sea level, which in
 * Denver (ground ~1.6 km) puts it a kilometre and a half under the city: on an
 * oblique view it sits visibly off its own junction. So the dot reads the same
 * shared ground floor every other anchored point in the app reads
 * (`cachedGroundFloor` — the rendered mesh cell on the photoreal stack, the
 * Re:Earth DEM cell on the keyless terrain stacks) and lifts clear of it.
 * Until that cell is warm there is no honest height, and the caller keeps the
 * dot hidden rather than drawing it somewhere wrong.
 * @param {number|null} floorM Ellipsoidal ground for the cell, or null.
 * @returns {number|null} Ellipsoidal render height, or null while unknown.
 */
export function stepMarkerHeightM(floorM, liftM) {
  return Number.isFinite(floorM) ? floorM + liftM : null;
}

/**
 * How long to wait before re-reading the ground floor again, or null when the
 * budget is spent. Quick at first, because most cells answer immediately from
 * a warm cache; slower afterwards, because what is left is a network round
 * trip. Pure.
 * @param {number} attempt Re-reads already made (0 for the first wait).
 * @param {number} elapsedMs Milliseconds since anchoring started.
 * @returns {number|null} Delay in ms, or null to stop.
 */
export function stepAnchorDelayMs(attempt, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs >= STEP_ANCHOR_DEADLINE_MS)
    return null;
  const delay =
    attempt < STEP_ANCHOR_FAST_ATTEMPTS
      ? STEP_ANCHOR_RETRY_MS
      : STEP_ANCHOR_SLOW_RETRY_MS;
  return Math.min(delay, STEP_ANCHOR_DEADLINE_MS - elapsedMs);
}

/**
 * The ordered turn-by-turn list for the layer row. Pure.
 * @param {{route: object|null, selectedStep: number|null, flightStep: number|null}} state
 * @returns {{ariaLabel: string, items: object[]}|null}
 */
export function directionsStepList({
  route,
  selectedStep = null,
  flightStep = null,
}) {
  const steps = route?.steps;
  if (!Array.isArray(steps) || !steps.length) return null;
  const active = Number.isInteger(flightStep) ? flightStep : selectedStep;
  const items = steps.map((step, index) => ({
    id: `step-${index}`,
    ordinal: index + 1,
    lead: formatRouteDistance(step.distanceM) || '—',
    text: step.instruction,
    active: index === active,
    current: Number.isInteger(flightStep) && index === flightStep,
    params: { step: index },
  }));
  if (route.stepsTruncated) {
    // The arrival step is missing, so the list must not end as if the reader
    // had arrived. A plain, unclickable last line says where it really stops.
    items.push({
      id: 'step-truncated',
      ordinal: items.length + 1,
      lead: '',
      text: isPortugueseDirections()
        ? `Só as primeiras ${steps.length} manobras desta rota aparecem`
        : `Only the first ${steps.length} turns of this route are shown`,
      active: false,
      current: false,
      disabled: true,
    });
  }
  return {
    ariaLabel: isPortugueseDirections()
      ? 'Instruções passo a passo'
      : 'Turn-by-turn directions',
    items,
  };
}

/**
 * Which maneuver the camera is on, given how far along the route it has flown.
 * Steps carry the length of the leg that FOLLOWS them, so the step in force is
 * the last one whose cumulative start is at or behind the camera. Pure.
 * @param {object[]} steps
 * @param {number} traveledM Metres flown from the start of the route.
 * @returns {number|null}
 */
export function stepIndexAtDistance(steps, traveledM) {
  if (!Array.isArray(steps) || !steps.length) return null;
  if (!Number.isFinite(traveledM) || traveledM < 0) return 0;
  let start = 0;
  for (let index = 0; index < steps.length; index += 1) {
    const end = start + Math.max(0, Number(steps[index]?.distanceM) || 0);
    if (traveledM < end) return index;
    start = end;
  }
  return steps.length - 1;
}

/**
 * Stats for the Data Layers row. Pure.
 * @param {{enabled:boolean, mode:string, a:object|null, b:object|null, status:string, error:string|null, route:object|null, lastUpdate:number|null, armed:null|'a'|'b'}} state
 * @returns {object}
 */
export function directionsStats(state) {
  const {
    mode,
    a,
    b,
    status,
    error,
    route,
    lastUpdate,
    armed,
    pointerBlocked,
  } = state;
  const pt = isPortugueseDirections();
  const source =
    route?.provider === 'tomtom'
      ? pt
        ? 'TomTom · trânsito ao vivo'
        : 'TomTom · live traffic'
      : pt
        ? 'OpenStreetMap (sem trânsito)'
        : 'OSM routing';
  if (pointerBlocked) {
    return {
      count: route?.steps.length || 0,
      lastUpdate,
      error: pt
        ? 'Outra ferramenta do mapa está usando os toques — feche-a e marque a origem de novo'
        : 'Another map tool is using clicks — close it, then SET A again',
      status: 'empty',
      source,
    };
  }
  if (status === 'routing') {
    return {
      count: 0,
      lastUpdate,
      error: null,
      loading: true,
      loadingLabel: pt ? 'Calculando a rota…' : 'Routing…',
      source,
    };
  }
  if (status === 'error') {
    return {
      count: 0,
      lastUpdate,
      error: error || (pt ? 'Nenhuma rota encontrada' : 'No route found'),
      status: 'empty',
      source,
    };
  }
  // The manager prints `loadingLabel` as the row's detail line whenever it is
  // set (not only while loading), so the route summary and the placement
  // guidance ride on it; `coverage` carries the same text for stats readers.
  if (route) {
    const word =
      (pt ? PT_MODES[mode]?.word : DIRECTIONS_MODES[mode]?.word) || mode;
    const delay = route.traffic?.delayS || 0;
    const arrival = clockTime(route.traffic?.arrival);
    const parts = [
      formatRouteDistance(route.distanceM),
      formatRouteDuration(route.durationS) +
        (delay >= 60
          ? pt
            ? ` (+${formatRouteDuration(delay)} de trânsito)`
            : ` (+${formatRouteDuration(delay)} traffic)`
          : ''),
    ];
    if (state.depart && route.traffic?.departure)
      parts.push(
        pt
          ? `saída ${clockTime(route.traffic.departure)}`
          : `leave ${clockTime(route.traffic.departure)}`,
      );
    if (arrival) parts.push(pt ? `chega ${arrival}` : `arrive ${arrival}`);
    if (Array.isArray(state.stops) && state.stops.length)
      parts.push(
        pt
          ? `${state.stops.length} parada${state.stops.length > 1 ? 's' : ''}`
          : `${state.stops.length} stop(s)`,
      );
    if (route.incidents?.length)
      parts.push(
        pt
          ? `${route.incidents.length} ocorrência${route.incidents.length > 1 ? 's' : ''}`
          : `${route.incidents.length} incident(s)`,
      );
    parts.push(word);
    if (route.stepsTruncated)
      parts.push(
        pt
          ? `primeiras ${route.steps.length} manobras`
          : `first ${route.steps.length} turns`,
      );
    if (pt && mode === 'car' && route.provider !== 'tomtom')
      parts.push('sem trânsito');
    const summary = parts.join(' · ');
    return {
      count: route.steps.length,
      lastUpdate,
      error: null,
      source,
      coverage: summary,
      loadingLabel: summary,
    };
  }
  let coverage;
  if (pt) {
    if (armed)
      coverage = `Toque no mapa para marcar ${armed === 'a' ? 'a origem' : armed === 'stop' ? 'a parada' : 'o destino'}`;
    else if (a && !b) coverage = 'Agora toque em DESTINO e depois no mapa';
    else if (!a && b) coverage = 'Toque em ORIGEM (ou DAQUI) e depois no mapa';
    else coverage = 'Toque em ORIGEM (ou DAQUI) e depois no mapa';
  } else if (armed)
    coverage = `Click the globe to place ${armed.toUpperCase()}`;
  else if (a && !b) coverage = 'SET B, then click the globe';
  else if (!a && b) coverage = 'SET A, then click the globe';
  else coverage = 'SET A, then click the globe';
  return {
    count: 0,
    lastUpdate,
    error: null,
    status: 'idle',
    source,
    coverage,
    loadingLabel: coverage,
  };
}

/**
 * Card copy for one maneuver.
 * @param {object[]} steps
 * @param {number} index
 * @returns {{title:string, details:string[]}}
 */
export function directionsStepCopy(steps, index) {
  const step = steps[index];
  const details = [];
  const leg = [];
  if (step.distanceM > 0) leg.push(formatRouteDistance(step.distanceM));
  if (step.durationS > 0) leg.push(formatRouteDuration(step.durationS));
  const pt = isPortugueseDirections();
  details.push(
    pt
      ? `Passo ${index + 1} de ${steps.length}${leg.length ? ` · depois ${leg.join(' · ')}` : ''}`
      : `Step ${index + 1} of ${steps.length}${leg.length ? ` · then ${leg.join(' · ')}` : ''}`,
  );
  const next = steps[index + 1];
  if (next) details.push(`${pt ? 'Depois' : 'Then'}: ${next.instruction}`);
  return { title: step.instruction, details };
}

/**
 * Shared-host card for the selected maneuver.
 * @param {number} index
 * @param {Cesium.Cartesian3} position
 * @param {{title:string, details:string[]}} copy
 * @returns {object|null}
 */
export function createDirectionsStepOverlayEntry(index, position, copy) {
  if (!Number.isInteger(index) || !position) return null;
  return {
    id: `directions-step-${index}`,
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title: copy.title,
    details: copy.details,
    accent: DIRECTIONS_ROUTE_COLOR,
    interactive: false,
    anchorRadiusPx: 9,
    minAnchorGapPx: 11,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/**
 * Build the `/api/route` URL for two endpoints.
 * @param {string} mode car | foot | bike
 * @param {{lat:number, lon:number}} a
 * @param {{lat:number, lon:number}} b
 * @returns {string}
 */
export { directionsRequestUrl } from './source.js';

/**
 * Validate a proxy payload into the route record the layer keeps, or null.
 * @param {object} payload
 * @param {string} mode
 * @returns {{distanceM:number, durationS:number, geometry:number[][], steps:object[], mode:string}|null}
 */
export function normalizeRoutePayload(payload, mode) {
  if (
    !payload ||
    payload.ok !== true ||
    !Array.isArray(payload.geometry) ||
    payload.geometry.length < 2
  )
    return null;
  const geometry = payload.geometry
    .map((pair) => [Number(pair?.[0]), Number(pair?.[1])])
    .filter(
      ([lon, lat]) =>
        Number.isFinite(lon) &&
        Number.isFinite(lat) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180,
    );
  if (geometry.length < 2) return null;
  const steps = (Array.isArray(payload.steps) ? payload.steps : [])
    .filter(
      (step) =>
        step &&
        typeof step.instruction === 'string' &&
        Number.isFinite(step.lat) &&
        Number.isFinite(step.lon),
    )
    .map((step, index) => ({ ...step, index }));
  const out = {
    distanceM: Math.max(0, Number(payload.distanceM) || 0),
    durationS: Math.max(0, Number(payload.durationS) || 0),
    geometry,
    steps,
    // A route with more maneuvers than the proxy will serve is cut off, and
    // the cut is shown rather than passed off as the whole route.
    stepsTruncated: payload.stepsTruncated === true,
    mode,
  };
  // barreto.top: traffic-aware extras (TomTom); absent for OSRM routes.
  if (payload.provider === 'tomtom') {
    out.provider = 'tomtom';
    const t = payload.traffic || {};
    out.traffic = {
      delayS: Math.max(0, Number(t.delayS) || 0),
      noTrafficS: Number.isFinite(Number(t.noTrafficS))
        ? Number(t.noTrafficS)
        : null,
      arrival: typeof t.arrival === 'string' ? t.arrival : null,
      departure: typeof t.departure === 'string' ? t.departure : null,
    };
    out.congestion = (
      Array.isArray(payload.congestion) ? payload.congestion : []
    )
      .filter(
        (c) =>
          Number.isInteger(c?.from) &&
          Number.isInteger(c?.to) &&
          c.from >= 0 &&
          c.to > c.from &&
          c.to < geometry.length,
      )
      .map((c) => ({
        from: c.from,
        to: c.to,
        magnitude: Number(c.magnitude) || 0,
        category: typeof c.category === 'string' ? c.category : 'OTHER',
        delayS: Math.max(0, Number(c.delayS) || 0),
      }));
    out.incidents = (Array.isArray(payload.incidents) ? payload.incidents : [])
      .filter(
        (i) =>
          Number.isFinite(i?.lat) &&
          Number.isFinite(i?.lon) &&
          INCIDENT_SYMBOLS[i.kind],
      )
      .slice(0, 50)
      .map((i) => ({
        lat: i.lat,
        lon: i.lon,
        kind: i.kind,
        label: typeof i.label === 'string' ? i.label : 'Ocorrência',
        delayS: Math.max(0, Number(i.delayS) || 0),
        pointIndex: Number.isInteger(i.pointIndex) ? i.pointIndex : null,
      }));
  }
  if (Array.isArray(payload.alternatives) && payload.alternatives.length)
    out.alternatives = payload.alternatives
      .map((alt) =>
        normalizeRoutePayload({ ...alt, alternatives: undefined }, mode),
      )
      .filter(Boolean)
      .slice(0, 2);
  return out;
}

/**
 * Construct one Directions layer over the application scene owners.
 *
 * Each catalog builds its own, so two applications on a page never share the
 * route, the markers, the pointer claim or the flight this layer owns. The
 * shared services are injected, which is what keeps this module's own imports
 * down to Cesium and the pure step formatter.
 * @param {{services: object, source: {getRoute: Function}}} options
 * @returns {object} The layer module the data manager registers.
 */
export function createDirectionsLayer({ services, source }) {
  if (typeof source?.getRoute !== 'function')
    throw new TypeError('Directions require a route source');
  /**
   * Where the maneuver card is drawn. Defaults to the shared world-overlay host;
   * tests swap it. Resolved on use, not at import, because the services arrive
   * after this module is evaluated.
   */
  const DEFAULT_OVERLAY_HOST = Object.freeze({
    setEntries: (...args) => services.overlays.setOverlayEntries(...args),
    setVisible: (...args) => services.overlays.setOverlaySourceVisible(...args),
    clearSource: (...args) => services.overlays.clearOverlaySource(...args),
  });
  let _overlayHost = DEFAULT_OVERLAY_HOST;

  // --- Module state ---
  let _viewer = null;
  let _enabled = false;
  let _mode = DEFAULT_DIRECTIONS_MODE;
  /** @type {null|'a'|'b'} which endpoint the next globe click places */
  let _armed = null;
  /** @type {{lat:number, lon:number}|null} */
  let _a = null;
  /** @type {{lat:number, lon:number}|null} */
  let _b = null;
  /** @type {'idle'|'routing'|'ready'|'error'} */
  let _status = 'idle';
  let _error = null;
  /** @type {{distanceM:number, durationS:number, geometry:number[][], steps:object[], mode:string}|null} */
  let _route = null;
  let _routeSeq = 0;
  let _routeAbort = null;
  let _lastUpdate = null;
  let _markerA = null;
  let _markerB = null;
  let _routeEntity = null;
  /** barreto.top: traffic overlays and alternative routes drawn with the route. */
  let _extraEntities = [];
  /** Every option the router returned (main first); `_route` is one of them. */
  let _routes = [];
  let _routeIndex = 0;
  let _avoidTolls = false;
  /** @type {{lat:number, lon:number, label?:string}[]} stops between A and B */
  let _stops = [];
  let _stopMarkers = [];
  /** Planned departure (ISO with offset) or null for "now". */
  let _depart = null;
  let _locating = false;
  let _refreshTimer = null;
  let _stepPoints = null;
  let _selectedStep = null;
  let _clickHandler = null;
  let _renderHeld = false;
  let _rowControlsListener = null;
  let _dataManager = null;
  /** Set when arming failed because another tool holds the pointer. */
  let _pointerBlocked = false;
  /**
   * What `claimPointer` handed back for the claim this layer currently holds, or
   * null. Held rather than re-derived so the release names THIS claim: a claim
   * that has already been superseded cannot free its successor's.
   */
  let _pointerClaim = null;
  /** Pending release of that claim, once the click being handled is over. */
  let _releaseTimer = null;
  /** Id of the route flight THIS layer started, while it is still running. */
  let _flightId = 0;
  let _flightTimer = null;
  /** Step the camera is on during FLY, or null. */
  let _flightStep = null;
  let _anchorTimer = null;
  let _anchorAttempts = 0;
  let _anchorStartedAt = 0;
  /**
   * Camera seams handed over by the UI shell: the one navigation-authority
   * facade every camera owner goes through, plus the shared ground-floor
   * read/warm the route dolly uses so it does not fly a mountain at sea level.
   */
  let _shellSeams = null;
  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  function state() {
    return {
      enabled: _enabled,
      mode: _mode,
      armed: _armed,
      a: _a,
      b: _b,
      status: _status,
      error: _error,
      route: _route,
      lastUpdate: _lastUpdate,
      selectedStep: _selectedStep,
      flightStep: _flightStep,
      pointerBlocked: _pointerBlocked,
      avoidTolls: _avoidTolls,
      stops: _stops,
      depart: _depart,
      routes: _routes,
      routeIndex: _routeIndex,
      locating: _locating,
      canLocate: Boolean(globalThis.navigator?.geolocation),
    };
  }

  function notifyRow() {
    try {
      _rowControlsListener?.();
    } catch {
      /* listener is best-effort */
    }
    _dataManager?.refreshLayerStats?.();
  }

  function syncRenderHold() {
    const shouldHold = _enabled && Boolean(_routeEntity);
    if (shouldHold && !_renderHeld) {
      services.render.holdContinuousRender('directions');
      _renderHeld = true;
    } else if (!shouldHold && _renderHeld) {
      services.render.releaseContinuousRender('directions');
      _renderHeld = false;
    }
  }

  function pickGround(screenPosition) {
    const cartesian = services.scenePick.pickGroundPosition(
      _viewer,
      screenPosition,
    );
    if (!cartesian) return null;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
    };
  }

  function markerEntity(letter, point, color) {
    return _viewer.entities.add({
      id: `directions:marker:${letter}`,
      position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat, 0),
      point: {
        pixelSize: 14,
        color,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: letter,
        font: 'bold 13px "JetBrains Mono", "SF Mono", monospace',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -20),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  function removeEntity(entity) {
    if (entity && _viewer && !_viewer.isDestroyed?.())
      _viewer.entities.remove(entity);
  }

  function placeMarker(letter, point) {
    if (!_viewer) return;
    if (letter === 'a') {
      removeEntity(_markerA);
      _markerA = markerEntity('A', point, MARKER_A_COLOR);
    } else {
      removeEntity(_markerB);
      _markerB = markerEntity('B', point, MARKER_B_COLOR);
    }
  }

  function redrawStopMarkers() {
    for (const marker of _stopMarkers) removeEntity(marker);
    _stopMarkers = [];
    if (!_viewer) return;
    _stops.forEach((stop, index) => {
      _stopMarkers.push(
        _viewer.entities.add({
          id: `directions:marker:stop:${index}`,
          position: Cesium.Cartesian3.fromDegrees(stop.lon, stop.lat, 0),
          point: {
            pixelSize: 12,
            color: Cesium.Color.fromCssColorString('#ffd60a'),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: String(index + 1),
            font: 'bold 12px "JetBrains Mono", "SF Mono", monospace',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -18),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    });
  }

  /** barreto.top: tell the page (route planner, "no caminho") what changed. */
  function announceRoute() {
    try {
      globalThis.dispatchEvent?.(
        new CustomEvent('barreto:route-changed', {
          detail: {
            route: _route,
            mode: _mode,
            depart: _depart,
            points: _a && _b ? [_a, ..._stops, _b] : [],
            a: _a,
            b: _b,
            stops: _stops,
            status: _status,
            routes: _routes,
            routeIndex: _routeIndex,
          },
        }),
      );
    } catch {
      /* no DOM events here */
    }
  }

  function clearRouteGraphics() {
    services.credits?.hideOsmCredit?.(_viewer, 'directions');
    _clearStepSelection();
    stopStepAnchoring();
    removeEntity(_routeEntity);
    _routeEntity = null;
    for (const entity of _extraEntities) removeEntity(entity);
    _extraEntities = [];
    _stepPoints?.removeAll();
    syncRenderHold();
  }

  /** Alternatives (dim, clickable) and slow stretches (coloured) of the route. */
  function drawRouteExtras(route) {
    _routes.forEach((option, index) => {
      if (option === route || option.geometry.length < 2) return;
      _extraEntities.push(
        _viewer.entities.add({
          id: `directions:alt:${index}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(
              option.geometry.flat(),
            ),
            width: 7,
            material:
              Cesium.Color.fromCssColorString('#9fb3c8').withAlpha(0.55),
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
            zIndex: 0,
          },
        }),
      );
    });
    for (const [n, incident] of (route.incidents || []).entries()) {
      const symbol = INCIDENT_SYMBOLS[incident.kind];
      _extraEntities.push(
        _viewer.entities.add({
          id: `directions:incident:${n}`,
          name: incident.label,
          position: Cesium.Cartesian3.fromDegrees(
            incident.lon,
            incident.lat,
            0,
          ),
          label: {
            text: symbol.glyph,
            font: '20px sans-serif',
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString(
              symbol.color,
            ).withAlpha(0.85),
            backgroundPadding: new Cesium.Cartesian2(6, 4),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -6),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    }
    for (const [n, slow] of (route.congestion || []).entries()) {
      const coords = route.geometry.slice(slow.from, slow.to + 1);
      if (coords.length < 2) continue;
      _extraEntities.push(
        _viewer.entities.add({
          id: `directions:traffic:${n}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(coords.flat()),
            width: 10,
            material: Cesium.Color.fromCssColorString(
              trafficColor(slow.magnitude, slow.category),
            ),
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
            zIndex: 2,
          },
        }),
      );
    }
  }

  function stopTrafficRefresh() {
    if (_refreshTimer) clearInterval(_refreshTimer);
    _refreshTimer = null;
  }

  /** Re-ask for a traffic-aware route every 5 min while it is on screen. */
  function syncTrafficRefresh() {
    const wanted =
      _enabled && _route?.provider === 'tomtom' && _a && _b && _mode === 'car';
    if (!wanted) return stopTrafficRefresh();
    if (_refreshTimer) return;
    _refreshTimer = setInterval(() => {
      if (
        globalThis.document?.visibilityState === 'hidden' ||
        _flightId ||
        _status === 'routing'
      )
        return;
      void requestRoute({ silent: true });
    }, 5 * 60_000);
  }

  function selectRouteOption(index) {
    const option = _routes[index];
    if (!option || option === _route) return false;
    cancelOwnedFlight('directions-alternative');
    _routeIndex = index;
    _route = option;
    drawRoute(option);
    announceRoute();
    return true;
  }

  function useCurrentLocation() {
    const geo = globalThis.navigator?.geolocation;
    if (!geo || _locating) return;
    _locating = true;
    notifyRow();
    geo.getCurrentPosition(
      (position) => {
        _locating = false;
        const point = {
          lat: Number(position?.coords?.latitude),
          lon: Number(position?.coords?.longitude),
        };
        if (!_enabled || !placeDirectionsEndpoint('a', point)) notifyRow();
      },
      () => {
        _locating = false;
        _shellSeams?.showToast?.(
          isPortugueseDirections()
            ? 'Não foi possível obter sua localização — permita o acesso à localização no navegador'
            : 'Could not get your location',
        );
        notifyRow();
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }

  function stopStepAnchoring() {
    if (_anchorTimer) clearTimeout(_anchorTimer);
    _anchorTimer = null;
    _anchorAttempts = 0;
    _anchorStartedAt = 0;
  }

  /**
   * Put every maneuver dot on the ground at its junction, and re-read the shared
   * floor while its cells are still warming. A dot whose cell has not answered
   * yet stays hidden: an unplaced dot is better than one drawn a kilometre below
   * the city it belongs to.
   */
  function anchorStepPoints() {
    _anchorTimer = null;
    if (!_stepPoints || !_route || !_enabled) return;
    const steps = _route.steps;
    const pending = [];
    let unresolved = 0;
    for (const index of stepMarkerIndices(steps)) {
      const step = steps[index];
      const point = findStepPoint(index);
      if (!point) continue;
      const height = stepMarkerHeightM(
        services.ground.cachedGroundFloor(step.lat, step.lon),
        services.ground.GROUND_FLOOR_LIFT_M,
      );
      if (height === null) {
        unresolved += 1;
        point.show = false;
        pending.push({ lat: step.lat, lon: step.lon });
        continue;
      }
      point.position = Cesium.Cartesian3.fromDegrees(
        step.lon,
        step.lat,
        height,
      );
      point.show = true;
    }
    // A card already open on a step that has just been anchored moves with it.
    if (_selectedStep !== null) refreshStepCard(_selectedStep);
    services.render.governorRequestRender('directions-anchor');
    if (!unresolved) {
      _anchorAttempts = 0;
      _anchorStartedAt = 0;
      return;
    }
    services.ground.warmGroundFloor(pending);
    const delay = stepAnchorDelayMs(
      _anchorAttempts,
      Date.now() - _anchorStartedAt,
    );
    _anchorAttempts += 1;
    if (delay === null) return;
    _anchorTimer = setTimeout(anchorStepPoints, delay);
  }

  function drawRoute(route) {
    clearRouteGraphics();
    if (!_viewer) return;
    services.annotations.ensureFlowFabricRegistered();
    const positions = Cesium.Cartesian3.fromDegreesArray(route.geometry.flat());
    _routeEntity = _viewer.entities.add({
      id: 'directions:route',
      polyline: {
        positions,
        width: 9,
        material: new services.annotations.FlowMaterialProperty(
          DIRECTIONS_ROUTE_COLOR,
        ),
        clampToGround: true,
        // BOTH: drape on 3D tiles when they are up and on terrain when they are
        // not, so the keyless globe shows the route too.
        classificationType: Cesium.ClassificationType.BOTH,
        zIndex: 1,
      },
    });
    drawRouteExtras(route);
    // One dot per decision; A and B already mark departure and arrival. The dots
    // start hidden and appear as anchorStepPoints resolves each ground cell.
    const cells = [];
    for (const index of stepMarkerIndices(route.steps)) {
      const step = route.steps[index];
      cells.push({ lat: step.lat, lon: step.lon });
      _stepPoints.add({
        id: `directions:step:${index}`,
        position: Cesium.Cartesian3.fromDegrees(step.lon, step.lat, 0),
        color: STEP_COLOR,
        pixelSize: STEP_PIXEL_SIZE,
        outlineColor: STEP_OUTLINE,
        outlineWidth: 2,
        show: false,
        // The shared ground floor is a coarse cell, and on the photoreal stack
        // the rendered mesh can stand above it. Keeping the dot always visible
        // is the same choice every other anchored sprite in the app makes.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    services.credits?.showOsmCredit?.(_viewer, 'directions');
    if (route.provider === 'tomtom')
      services.credits?.registerDynamicCredit?.(_viewer, {
        key: 'tomtom-routing',
        html: 'Routes and live traffic © <a href="https://www.tomtom.com" target="_blank" rel="noopener">TomTom</a>',
      });
    services.ground.warmGroundFloor(cells);
    _anchorAttempts = 0;
    _anchorStartedAt = Date.now();
    anchorStepPoints();
    syncRenderHold();
    services.sprites.restoreSpriteOrder(_viewer);
    services.render.governorRequestRender('directions-route');
  }

  async function requestRoute({ silent = false } = {}) {
    if (!_a || !_b || !_enabled) return;
    // The route under an owned flight is about to be replaced, and a dolly
    // cannot be re-pointed mid-cut. Land it first (only if it is still ours).
    if (!silent) cancelOwnedFlight('directions-reroute');
    _routeAbort?.abort();
    const controller = new AbortController();
    _routeAbort = controller;
    const timer = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
    _routeSeq += 1;
    const seq = _routeSeq;
    const mode = _mode;
    const previousIndex = _routeIndex;
    if (!silent) {
      _status = 'routing';
      _error = null;
      notifyRow();
    }
    try {
      const payload = await source.getRoute(
        {
          mode,
          a: _a,
          b: _b,
          lang: isPortugueseDirections() ? 'pt' : undefined,
          avoidTolls: _avoidTolls,
          stops: _stops,
          depart: _depart,
        },
        {
          signal: controller.signal,
        },
      );
      if (seq !== _routeSeq || !_enabled) return;
      const route = normalizeRoutePayload(payload, mode);
      if (!route && silent) return;
      if (!route) {
        _routes = [];
        _routeIndex = 0;
        _route = null;
        clearRouteGraphics();
        _status = 'error';
        const pt = isPortugueseDirections();
        _error =
          payload?.error === 'no route found'
            ? pt
              ? 'Nenhuma rota encontrada entre a origem e o destino'
              : 'No route found between A and B'
            : payload?.error
              ? pt
                ? `Falha ao calcular a rota: ${payload.error}`
                : `Routing failed: ${payload.error}`
              : pt
                ? 'Nenhuma rota encontrada entre a origem e o destino'
                : 'No route found between A and B';
        return;
      }
      _routes = [route, ...(route.alternatives || [])];
      _routeIndex =
        silent && previousIndex < _routes.length ? previousIndex : 0;
      _route = _routes[_routeIndex];
      _status = 'ready';
      _lastUpdate = Date.now();
      // A silent traffic refresh keeps a flight that is riding the old line.
      if (!(silent && _flightId)) drawRoute(_route);
    } catch (error) {
      if (seq !== _routeSeq || !_enabled) return;
      if (silent) return;
      _routes = [];
      _routeIndex = 0;
      _route = null;
      clearRouteGraphics();
      _status = 'error';
      // A fetch that never reaches the proxy rejects with the browser's own
      // wording ("Failed to fetch"), which tells a reader nothing. Say what
      // happened instead.
      const pt = isPortugueseDirections();
      _error =
        error?.name === 'AbortError'
          ? pt
            ? 'O cálculo da rota demorou demais'
            : 'Routing timed out'
          : error?.name === 'TypeError'
            ? pt
              ? 'Rotas indisponíveis — o serviço não respondeu'
              : 'Routing unavailable — no response from the routing service'
            : error?.message ||
              (pt ? 'Rotas indisponíveis' : 'Routing unavailable');
    } finally {
      clearTimeout(timer);
      if (_routeAbort === controller) _routeAbort = null;
      syncTrafficRefresh();
      if (seq === _routeSeq) {
        notifyRow();
        announceRoute();
      }
      services.render.governorRequestRender('directions-route');
    }
  }

  /** Stop arming, and give the pointer back if this layer holds it. */
  function releaseClaim() {
    if (_releaseTimer) clearTimeout(_releaseTimer);
    _releaseTimer = null;
    if (_pointerClaim !== null) services.input.releasePointer(_pointerClaim);
    _pointerClaim = null;
  }

  /**
   * Give the pointer back, but only once the click that consumed it has finished
   * being dispatched.
   *
   * Every layer binds its own handler to the same canvas, and they all run
   * inside ONE browser event. Releasing the claim the instant this layer places
   * an endpoint hands the rest of that same click to every ambient handler
   * registered after this one — placing A on top of a bikeshare station also
   * deselected the station. A timer, not a microtask: a microtask checkpoint
   * runs between two DOM listeners, which is exactly the gap this closes.
   */
  function releaseClaimAfterDispatch() {
    if (_pointerClaim === null || _releaseTimer) return;
    _releaseTimer = setTimeout(() => {
      _releaseTimer = null;
      releaseClaim();
    }, 0);
  }

  /**
   * Stop arming.
   * @param {{afterDispatch?: boolean}} [options] `afterDispatch` holds the
   *   pointer claim until the click being handled has finished dispatching.
   */
  function disarm({ afterDispatch = false } = {}) {
    _armed = null;
    _pointerBlocked = false;
    if (afterDispatch) releaseClaimAfterDispatch();
    else releaseClaim();
  }

  /**
   * Place one endpoint at a picked ground point and reroute when both are set.
   *
   * The globe click handler is the only caller in the running app; it is
   * exported because a ScreenSpaceEventHandler needs a real canvas, and the
   * ownership timing this function decides is exactly what has to be tested.
   * @param {'a'|'b'} which Which endpoint to place.
   * @param {{lat: number, lon: number}} point Ground point in degrees.
   * @returns {boolean} Whether the endpoint was placed.
   */
  function placeDirectionsEndpoint(which, point) {
    if (which !== 'a' && which !== 'b' && which !== 'stop') return false;
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon))
      return false;
    // The claim is held until this click has finished being dispatched, so the
    // ambient handlers that run after this one still see the pointer as taken.
    disarm({ afterDispatch: true });
    if (which === 'stop') {
      if (_stops.length >= MAX_STOPS) return false;
      _stops = [..._stops, point];
      redrawStopMarkers();
    } else {
      if (which === 'a') _a = point;
      else _b = point;
      placeMarker(which, point);
    }
    if (_a && _b) void requestRoute();
    else notifyRow();
    services.render.governorRequestRender('directions-place');
    return true;
  }

  /**
   * Arm (or cancel) a globe click for one endpoint.
   *
   * Placement is a TOOL: it takes the pointer so no ambient layer also selects
   * whatever happened to be under the click. If another tool already holds it,
   * this refuses — nothing is armed and the row says why.
   * @param {null|'a'|'b'} which
   * @returns {boolean} Whether the layer is armed after this call.
   */
  function setArmed(which) {
    if (!which) {
      disarm();
      return false;
    }
    // A claim does not stack, not even under the same name — two live instances
    // of one tool are two owners. So re-arming for the other endpoint reuses the
    // lease already held instead of asking for a second one.
    if (!services.input.isLeaseCurrent(_pointerClaim)) {
      const lease = services.input.claimPointer(DIRECTIONS_POINTER_OWNER);
      if (!lease) {
        _armed = null;
        _pointerBlocked = true;
        // The row already says it, but the row is not where the operator is
        // looking after pressing a chip — say it where the app says everything.
        const message = pointerBlockedMessage(
          services.input.pointerOwner(),
          which,
        );
        if (message) _shellSeams?.showToast?.(message);
        return false;
      }
      _pointerClaim = lease;
    }
    // A pending release from the previous placement would otherwise hand the
    // pointer back while this new arming still needs it.
    if (_releaseTimer) {
      clearTimeout(_releaseTimer);
      _releaseTimer = null;
    }
    _pointerBlocked = false;
    _armed = which;
    _clearStepSelection();
    return true;
  }

  function clearAll() {
    _routeAbort?.abort();
    _routeAbort = null;
    _routeSeq += 1;
    cancelOwnedFlight('directions-clear');
    disarm();
    _a = null;
    _b = null;
    _route = null;
    _routes = [];
    _routeIndex = 0;
    _stops = [];
    redrawStopMarkers();
    stopTrafficRefresh();
    _status = 'idle';
    _error = null;
    removeEntity(_markerA);
    removeEntity(_markerB);
    _markerA = null;
    _markerB = null;
    clearRouteGraphics();
    announceRoute();
    services.render.governorRequestRender('directions-clear');
  }

  /**
   * Stop the route flight THIS layer started — and only that one. The camera is
   * shared: by the time CLEAR is pressed the user may have grabbed it, voice may
   * have flown somewhere, or a tracked aircraft may own it. Cancelling by id
   * leaves every one of those alone.
   * @param {string} reason
   * @returns {boolean} Whether a flight of ours was stopped.
   */
  function cancelOwnedFlight(reason) {
    stopFlightProgress();
    if (!_flightId) return false;
    const { wasActive } = services.camera.interruptCameraMotionIfActive(
      _flightId,
      reason,
    );
    _flightId = 0;
    _flightStep = null;
    return wasActive;
  }

  function stopFlightProgress() {
    if (_flightTimer) clearInterval(_flightTimer);
    _flightTimer = null;
  }

  /** Follow the owned flight so the list can highlight the step being flown. */
  function trackFlightProgress() {
    stopFlightProgress();
    if (!_flightId) return;
    _flightTimer = setInterval(() => {
      const motion = services.camera.getActiveCameraMotion();
      if (!motion || motion.motionId !== _flightId) {
        // The flight finished, or something else took the camera. Either way it
        // is no longer ours to stop.
        _flightId = 0;
        _flightStep = null;
        stopFlightProgress();
        notifyRow();
        return;
      }
      const next = stepIndexAtDistance(_route?.steps, motion.traveledM);
      if (next !== _flightStep) {
        _flightStep = next;
        notifyRow();
      }
    }, FLIGHT_PROGRESS_MS);
  }

  function flyCurrentRoute() {
    if (!_route || !_viewer) return false;
    cancelOwnedFlight('directions-refly');
    services.camera.initCameraVerbs(_viewer);
    const seams = _shellSeams;
    const result = services.camera.flyRoute(
      [
        {
          type: 'route',
          label: 'Directions',
          path: _route.geometry.map(([lon, lat]) => ({ lon, lat, height: 0 })),
        },
      ],
      { speed: 'normal' },
      // The dolly reads the shared ground floor (and warms the corridor ahead of
      // itself) exactly as the voice route flight does; without it a mountain
      // corridor is flown at sea level.
      typeof seams?.floorFn === 'function' ? seams.floorFn : null,
      // One camera owner: the UI shell's immediate-navigation facade stamps the
      // navigation generation and releases whatever held the camera before the
      // flight starts. Without the shell (tests, a bare viewer) the flight still
      // runs, it just has nothing to take the camera from.
      typeof seams?.runNavigation === 'function' ? seams.runNavigation : null,
      typeof seams?.warmFn === 'function' ? seams.warmFn : null,
    );
    if (result?.ok !== true) {
      console.warn('[Data:Directions] fly refused:', result?.error || result);
      return false;
    }
    _flightId = result.motionId || 0;
    _flightStep = 0;
    trackFlightProgress();
    return true;
  }

  // --- Step selection ---

  function _clearStepSelection() {
    if (_selectedStep !== null && _stepPoints) {
      const point = findStepPoint(_selectedStep);
      if (point) point.pixelSize = STEP_PIXEL_SIZE;
    }
    _selectedStep = null;
    _overlayHost.clearSource(DIRECTIONS_STEP_OVERLAY_SOURCE_ID);
  }

  function findStepPoint(index) {
    if (!_stepPoints) return null;
    const id = `directions:step:${index}`;
    for (let i = 0; i < _stepPoints.length; i += 1) {
      const point = _stepPoints.get(i);
      if (point.id === id) return point;
    }
    return null;
  }

  /**
   * Where a step's card should hang, or null while that is not yet known.
   *
   * Departure and arrival have no maneuver dot — the A and B markers stand for
   * them — and an intermediate dot exists only once its ground cell has
   * answered. So the anchor is resolved from the step's own coordinates against
   * the same shared floor, and a step whose cell is still cold has no anchor at
   * all rather than one at sea level.
   * @param {number} index Step index.
   * @returns {Cesium.Cartesian3|null}
   */
  function stepAnchorPosition(index) {
    const step = _route?.steps?.[index];
    if (!step) return null;
    const point = findStepPoint(index);
    if (point?.show) return Cesium.Cartesian3.clone(point.position);
    const height = stepMarkerHeightM(
      services.ground.cachedGroundFloor(step.lat, step.lon),
      services.ground.GROUND_FLOOR_LIFT_M,
    );
    if (height === null) {
      services.ground.warmGroundFloor([{ lat: step.lat, lon: step.lon }]);
      return null;
    }
    return Cesium.Cartesian3.fromDegrees(step.lon, step.lat, height);
  }

  function refreshStepCard(index) {
    const position = stepAnchorPosition(index);
    if (!position) return false;
    const entry = createDirectionsStepOverlayEntry(
      index,
      position,
      directionsStepCopy(_route.steps, index),
    );
    if (!entry) return false;
    _overlayHost.setEntries(
      DIRECTIONS_STEP_OVERLAY_SOURCE_ID,
      [entry],
      DIRECTIONS_STEP_OVERLAY_SOURCE_OPTIONS,
    );
    return true;
  }

  /**
   * Open the card for one step. Every step in the list can be opened, including
   * departure and arrival; what a step needs is a resolved ground anchor, not a
   * dot primitive.
   * @param {number} index Step index.
   * @returns {boolean} Whether the card opened.
   */
  function _selectStep(index) {
    _clearStepSelection();
    if (!_route || !Number.isInteger(index) || !_route.steps[index])
      return false;
    if (!refreshStepCard(index)) {
      // The ground cell is still cold; the anchoring loop will not open a card
      // the reader did not ask for, so say nothing rather than draw it wrong.
      return false;
    }
    _selectedStep = index;
    const point = findStepPoint(index);
    if (point) point.pixelSize = STEP_SELECTED_PIXEL_SIZE;
    services.render.governorRequestRender('directions-select');
    return true;
  }

  function stepIndexFromPick(picked) {
    const candidates = [picked?.primitive?.id, picked?.id];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const match = /^directions:step:(\d+)$/.exec(candidate);
      if (match) return Number(match[1]);
    }
    return null;
  }

  function _onKeyDown(event) {
    if (event.key !== 'Escape') return;
    if (_armed) {
      disarm();
      notifyRow();
    } else if (_selectedStep !== null) {
      _clearStepSelection();
    }
  }

  function _installClickHandler(viewer) {
    if (_clickHandler) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      if (!_enabled) return;
      // Placement acts only while this layer actually HOLDS the pointer, and the
      // maneuver-dot selection below is an ambient handler like any other: it
      // yields the moment a tool (this one included) owns the click.
      // The lease, not the owner name: a superseded instance of this layer must
      // not act on a click its replacement owns.
      if (_armed && services.input.isLeaseCurrent(_pointerClaim)) {
        const point = pickGround(click.position);
        if (!point) return;
        placeDirectionsEndpoint(_armed, point);
        return;
      }
      if (!services.input.isPointerFree()) return;
      let picked = null;
      try {
        picked = viewer.scene.pick(click.position);
      } catch {
        picked = null;
      }
      const index = stepIndexFromPick(picked);
      if (index !== null) {
        _selectStep(index);
        return;
      }
      const altId = typeof picked?.id?.id === 'string' ? picked.id.id : '';
      const alt = /^directions:alt:(\d+)$/.exec(altId);
      if (alt) {
        if (selectRouteOption(Number(alt[1]))) notifyRow();
        return;
      }
      if (_selectedStep !== null) _clearStepSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    if (typeof document !== 'undefined')
      document.addEventListener('keydown', _onKeyDown);
  }

  function _removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    // Teardown can outlive the document (page unload, and every headless test).
    if (typeof document !== 'undefined')
      document.removeEventListener('keydown', _onKeyDown);
  }

  // ---------------------------------------------------------------------------
  // Layer module
  // ---------------------------------------------------------------------------

  const directionsLayer = {
    id: 'directions',
    name: 'Directions',
    icon: '🧭',
    source: 'OSM routing / TomTom',
    updateInterval: 0,

    /**
     * Create the maneuver-dot collection. Called once at bootstrap.
     * @param {Cesium.Viewer} viewer
     */
    init(viewer) {
      _viewer = viewer;
      _stepPoints = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      viewer.scene.primitives.add(_stepPoints);
      services.sprites.registerSpriteCollection('directions', _stepPoints);
      _stepPoints.show = false;
      _enabled = false;
      _mode = DEFAULT_DIRECTIONS_MODE;
      disarm();
      _a = null;
      _b = null;
      _route = null;
      _status = 'idle';
      _error = null;
      _flightStep = null;
      _overlayHost.setVisible(DIRECTIONS_STEP_OVERLAY_SOURCE_ID, false);
      services.sprites.restoreSpriteOrder(viewer);
      console.log('[Data:Directions] Initialized');
    },

    /**
     * Show the row chips and listen for placement clicks.
     * @param {Cesium.Viewer} viewer
     */
    enable(viewer) {
      _enabled = true;
      _pointerBlocked = false;
      _stepPoints.show = true;
      _overlayHost.setVisible(DIRECTIONS_STEP_OVERLAY_SOURCE_ID, true);
      _installClickHandler(viewer);
      services.picking.registerPickOwner(
        'directions',
        (pickedId) =>
          typeof pickedId === 'string' && pickedId.startsWith('directions:'),
      );
      syncRenderHold();
      services.sprites.restoreSpriteOrder(viewer);
    },

    /**
     * Remove the route, markers and listeners.
     * @param {Cesium.Viewer} viewer
     */
    disable(viewer) {
      _enabled = false;
      clearAll();
      _overlayHost.setVisible(DIRECTIONS_STEP_OVERLAY_SOURCE_ID, false);
      _removeClickHandler();
      services.picking.unregisterPickOwner('directions');
      if (_stepPoints) _stepPoints.show = false;
      syncRenderHold();
      void viewer;
    },

    /** Nothing to poll: routes are requested on placement and mode change. */
    async update() {},

    /**
     * Chip and programmatic writes. `mode` is state; `arm` is state (which
     * endpoint the next globe click places); `swap`, `fly` and `clear` are
     * one-shot commands that leave no param behind.
     * @param {object} params
     * @returns {boolean} false when the patch names an unknown mode.
     */
    setParams(params = {}) {
      const patch = normalizeDirectionsParams(params);
      if (!patch) return false;
      if (patch.clear) clearAll();
      if (patch.mode !== undefined && patch.mode !== _mode) {
        _mode = patch.mode;
        if (_a && _b && _enabled) void requestRoute();
      }
      if (patch.arm !== undefined) setArmed(patch.arm);
      if (patch.avoidTolls !== undefined && patch.avoidTolls !== _avoidTolls) {
        _avoidTolls = patch.avoidTolls;
        if (_a && _b && _enabled && _mode === 'car') void requestRoute();
      }
      if (patch.route !== undefined && patch.route !== null)
        selectRouteOption(patch.route);
      if (patch.here) useCurrentLocation();
      let reroute = false;
      if (patch.points) {
        const pts = patch.points;
        disarm();
        _a = pts[0];
        placeMarker('a', _a);
        if (pts.length >= 2) {
          _b = pts[pts.length - 1];
          placeMarker('b', _b);
          _stops = pts.slice(1, -1);
        } else _stops = [];
        redrawStopMarkers();
        reroute = true;
      }
      if (patch.depart !== undefined && patch.depart !== _depart) {
        _depart = patch.depart;
        reroute = true;
      }
      if (patch.removeStop !== undefined && _stops[patch.removeStop]) {
        _stops = _stops.filter((_, i) => i !== patch.removeStop);
        redrawStopMarkers();
        reroute = true;
      }
      if (patch.clearStops && _stops.length) {
        _stops = [];
        redrawStopMarkers();
        reroute = true;
      }
      if (reroute) {
        if (_a && _b && _enabled) void requestRoute();
        else announceRoute();
      }
      if (patch.refresh && _a && _b && _enabled) void requestRoute();
      if (patch.swap && _a && _b) {
        [_a, _b] = [_b, _a];
        _stops = [..._stops].reverse();
        redrawStopMarkers();
        placeMarker('a', _a);
        placeMarker('b', _b);
        if (_enabled) void requestRoute();
      }
      if (patch.step !== undefined) {
        if (patch.step === null) _clearStepSelection();
        else _selectStep(patch.step);
      }
      if (patch.fly) flyCurrentRoute();
      notifyRow();
      services.render.governorRequestRender('directions-params');
      return true;
    },

    getParams() {
      return _avoidTolls ? { mode: _mode, avoidTolls: true } : { mode: _mode };
    },

    getRowControls() {
      return directionsRowControls(state());
    },

    /**
     * Install the manager's row re-render callback (placement and routing land
     * outside any manager tick).
     * @param {(() => void)|null} listener
     */
    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return directionsStats(state());
    },

    /**
     * Keep a manager handle so placement and routing can repaint the row.
     * @param {object} dataManager DataLayerManager instance.
     */
    attachDataManager(dataManager) {
      _dataManager = dataManager;
    },

    /**
     * Receive the UI shell's camera seams. FLY goes through `runNavigation` —
     * the same immediate-navigation facade voice destinations use — so the route
     * dolly is one more caller of the single camera owner rather than a second
     * one. `floorFn`/`warmFn` are the shared ground floor the dolly flies over.
     * `showToast` is the app's own toast, so a refusal is said where the rest of
     * the UI says things.
     * @param {{runNavigation?: Function, floorFn?: Function, warmFn?: Function,
     *   showToast?: Function}|null} services
     */
    attachShellServices(services) {
      _shellSeams = services || null;
    },

    /**
     * Tear down entirely.
     * @param {Cesium.Viewer} viewer
     */
    destroy(viewer) {
      if (_enabled) this.disable(viewer);
      // disable() has already run these, but destroy() must also be safe on a
      // layer that was never enabled: a claim or a flight left behind would
      // outlive the whole application.
      cancelOwnedFlight('directions-destroy');
      stopTrafficRefresh();
      stopStepAnchoring();
      disarm();
      _shellSeams = null;
      _dataManager = null;
      _rowControlsListener = null;
      if (_stepPoints) {
        services.sprites.unregisterSpriteCollection('directions', _stepPoints);
        viewer.scene.primitives.remove(_stepPoints);
        _stepPoints = null;
      }
      _overlayHost.clearSource(DIRECTIONS_STEP_OVERLAY_SOURCE_ID);
      _viewer = null;
    },

    /**
     * Place one endpoint at a picked ground point. The globe click handler is
     * the only caller in the running app; it is on the instance because a
     * ScreenSpaceEventHandler needs a real canvas, and the ownership timing
     * this decides is exactly what has to be tested.
     */
    placeEndpoint: placeDirectionsEndpoint,

    /** Test seam: swap the shared overlay host. */
    _setOverlayHostForTest(host) {
      _overlayHost = host || DEFAULT_OVERLAY_HOST;
    },
  };

  return directionsLayer;
}
