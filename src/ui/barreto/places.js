/**
 * barreto.top: shared helpers for place search, "where am I looking",
 * favourites and camera moves used by the search box, the location chip and
 * the route planner.
 */
import * as Cesium from 'cesium';

/** Camera centre on the ground (or null) and the camera height in metres. */
export function cameraView(viewer) {
  try {
    const scene = viewer?.scene;
    const canvas = scene?.canvas;
    if (!canvas) return null;
    const center = new Cesium.Cartesian2(
      canvas.clientWidth / 2,
      canvas.clientHeight / 2,
    );
    const hit = viewer.camera.pickEllipsoid(center, scene.globe.ellipsoid);
    const height = viewer.camera.positionCartographic?.height ?? null;
    if (!hit) return { lat: null, lon: null, height };
    const c = Cesium.Cartographic.fromCartesian(hit);
    return {
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
      height,
    };
  } catch {
    return null;
  }
}

/** Fly to a place; a bounding box frames the whole area. */
export function flyToPlace(viewer, place, { range = 2500 } = {}) {
  if (!viewer?.camera || !place) return;
  viewer.camera.cancelFlight?.();
  const box = Array.isArray(place.bbox) ? place.bbox : null;
  if (box && box[2] - box[0] > 0.004 && box[3] - box[1] > 0.004) {
    viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(box[0], box[1], box[2], box[3]),
      duration: 2.5,
    });
    return;
  }
  const lat = Number(place.lat);
  const lon = Number(place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  // Look down at 45°, standing back so the place sits in the centre.
  const back = range / 111_320;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat - back, range),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-45),
      roll: 0,
    },
    duration: 2.5,
  });
}

async function getJson(url, { signal, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    signal,
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Search places (Brazil first) near an optional centre. */
export async function searchPlaces(q, center, { signal } = {}) {
  const u = new URL(
    '/api/br/search',
    globalThis.location?.origin || 'http://x',
  );
  u.searchParams.set('q', q);
  if (Number.isFinite(center?.lat) && Number.isFinite(center?.lon)) {
    u.searchParams.set('lat', center.lat.toFixed(2));
    u.searchParams.set('lon', center.lon.toFixed(2));
  }
  const data = await getJson(u.pathname + u.search, { signal });
  return Array.isArray(data?.results) ? data.results : [];
}

/** Bairro / cidade / estado at a point; `polygon` adds its outline. */
export async function reversePlace(
  lat,
  lon,
  level,
  { polygon = false, signal } = {},
) {
  const q = new URLSearchParams({
    lat: lat.toFixed(5),
    lon: lon.toFixed(5),
    level,
  });
  if (polygon) q.set('polygon', '1');
  return getJson(`/api/br/reverse?${q}`, { signal });
}

/** Which administrative level fits a camera height. */
export function levelForHeight(height) {
  if (!Number.isFinite(height)) return 'cidade';
  if (height < 20_000) return 'bairro';
  if (height < 350_000) return 'cidade';
  if (height < 4_000_000) return 'estado';
  return null;
}

// ---------------------------------------------------------------- favourites
const LOCAL_KEY = 'barreto:favorites:v1';
let favorites = null;
const listeners = new Set();

function readLocal() {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(LOCAL_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeLocal(list) {
  try {
    globalThis.localStorage?.setItem(LOCAL_KEY, JSON.stringify(list));
  } catch {
    /* storage off */
  }
}
function emit() {
  for (const fn of listeners) {
    try {
      fn(favorites);
    } catch {
      /* listener errors stay local */
    }
  }
}

/** Saved places: server copy (follows the person) with a local fallback. */
export async function loadFavorites() {
  if (favorites) return favorites;
  favorites = readLocal();
  try {
    const data = await getJson('/api/br/favorites');
    if (Array.isArray(data?.favorites)) {
      // First sync from a device that saved places before the server knew.
      if (!data.favorites.length && favorites.length)
        await saveFavorites(favorites);
      else favorites = data.favorites;
    }
  } catch {
    /* offline: keep the local list */
  }
  writeLocal(favorites);
  emit();
  return favorites;
}

export async function saveFavorites(list) {
  favorites = list.slice(0, 30);
  writeLocal(favorites);
  emit();
  try {
    const data = await getJson('/api/br/favorites', {
      method: 'PUT',
      body: { favorites },
    });
    if (Array.isArray(data?.favorites)) favorites = data.favorites;
  } catch {
    /* saved locally; the server copy catches up on the next change */
  }
  return favorites;
}

export function addFavorite(place, name) {
  const entry = {
    name: String(name || place?.name || 'Favorito')
      .trim()
      .slice(0, 40),
    lat: Number(place.lat),
    lon: Number(place.lon),
    detail: String(place.detail || '').slice(0, 120),
  };
  const rest = (favorites || []).filter(
    (f) => f.name.toLowerCase() !== entry.name.toLowerCase(),
  );
  return saveFavorites([entry, ...rest]);
}

export function removeFavorite(name) {
  return saveFavorites((favorites || []).filter((f) => f.name !== name));
}

export function onFavorites(fn) {
  listeners.add(fn);
  if (favorites) fn(favorites);
  return () => listeners.delete(fn);
}

export const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );

/** Material Symbols name for a search result kind. */
export function placeIcon(result) {
  const t = result?.type;
  if (t === 'house') return 'home_pin';
  if (t === 'street') return 'add_road';
  if (t === 'city' || t === 'county') return 'location_city';
  if (t === 'state' || t === 'country') return 'map';
  if (t === 'district' || t === 'locality') return 'holiday_village';
  return 'place';
}
