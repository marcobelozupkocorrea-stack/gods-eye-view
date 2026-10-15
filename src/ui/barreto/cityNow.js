/**
 * barreto.top: "Minha cidade agora" — one tap turns the map into a city
 * view: live traffic, incidents, real buses, Brazil rain radar and the
 * alerts, centred on where the person is (or their first area / place),
 * and turns off the global layers that only clutter a street view.
 * "Desfazer" puts the layers and the camera back.
 */
import * as Cesium from 'cesium';

export const CITY_LAYERS_ON = Object.freeze([
  'traffic',
  'traffic-incidents',
  'city-buses',
  'brazil-radar',
  'inmet-alerts',
  'defesa-civil-alerts',
  'cemaden-alerts',
]);

/** Global layers that only add noise to a city view. */
export const CITY_LAYERS_OFF = Object.freeze([
  'flights',
  'military',
  'satellites',
  'ais-live-vessels',
  'local-firms',
  'deter-alerts',
  'weather-satellite',
  'weather-radar',
  'wind',
]);

/** Camera for a city: about 5 km up, tilted, the point in the centre. */
export function cityCamera(lat, lon, { height = 5200, pitchDeg = -58 } = {}) {
  const back =
    height / Math.tan((Math.abs(pitchDeg) * Math.PI) / 180) / 111_320;
  return { lat: lat - back, lon, height, pitchDeg };
}

let deps = null;
let toast = null;
let toastTimer = 0;

function showToast(text, action = null) {
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'barreto-citynow-toast';
    toast.setAttribute('role', 'status');
    toast.hidden = true;
    document.body.append(toast);
  }
  clearTimeout(toastTimer);
  toast.replaceChildren();
  const span = document.createElement('span');
  span.textContent = text;
  toast.append(span);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      toast.hidden = true;
      action.run();
    });
    toast.append(b);
  }
  toast.hidden = false;
  toastTimer = setTimeout(() => (toast.hidden = true), action ? 9000 : 4000);
}

function geolocate() {
  const geo = globalThis.navigator?.geolocation;
  if (!geo) return Promise.reject(new Error('sem_gps'));
  return new Promise((resolve, reject) =>
    geo.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      reject,
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60_000 },
    ),
  );
}

async function fallbackPoint() {
  // First area, then first saved place (both kept on the server).
  for (const url of ['/api/br/areas', '/api/br/favorites']) {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) continue;
      const body = await res.json();
      const first = (body?.areas || body?.favorites || [])[0];
      if (Number.isFinite(first?.lat) && Number.isFinite(first?.lon))
        return {
          lat: first.lat,
          lon: first.lon,
          name: first.nome || first.name,
        };
    } catch {
      /* next */
    }
  }
  return null;
}

/** Set up once (needs the layer manager and the viewer). */
export function installCityNow({ styleManager, dataManager, signal } = {}) {
  deps = { styleManager, dataManager };
  signal?.addEventListener('abort', () => {
    deps = null;
    toast?.remove();
    toast = null;
  });
}

/**
 * Go. `point` skips the location lookup (e.g. from "Perto de você").
 * @returns {Promise<boolean>}
 */
export async function goCityNow(point = null) {
  const viewer = deps?.styleManager?.viewer;
  const layers = deps?.dataManager;
  if (!viewer || !layers) return false;
  let where = point;
  if (!where) {
    showToast('Procurando sua localização…');
    where = await geolocate().catch(() => null);
    if (!where) where = await fallbackPoint();
  }
  if (!where) {
    showToast(
      'Sem localização: libere a localização do app ou salve um lugar ou área.',
    );
    return false;
  }
  // Remember what to restore.
  const before = new Map();
  for (const id of [...CITY_LAYERS_ON, ...CITY_LAYERS_OFF])
    if (layers.layers?.has?.(id)) before.set(id, layers.isEnabled(id));
  const camera = viewer.camera;
  const saved = {
    destination: Cesium.Cartesian3.clone(camera.positionWC),
    orientation: {
      heading: camera.heading,
      pitch: camera.pitch,
      roll: camera.roll,
    },
  };
  const changes = [];
  for (const id of CITY_LAYERS_OFF)
    if (before.get(id))
      changes.push(layers.setEnabled(id, false, { origin: 'user' }));
  for (const id of CITY_LAYERS_ON)
    if (before.has(id) && !before.get(id))
      changes.push(layers.setEnabled(id, true, { origin: 'user' }));
  await Promise.allSettled(changes);
  const cam = cityCamera(where.lat, where.lon);
  camera.cancelFlight?.();
  camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.height),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(cam.pitchDeg),
      roll: 0,
    },
    duration: 2.2,
  });
  const turnedOff = CITY_LAYERS_OFF.filter((id) => before.get(id)).length;
  showToast(
    `Trânsito, ocorrências, ônibus, radar e alertas ligados${where.name ? ` em ${where.name}` : ''}.${turnedOff ? ` ${turnedOff} camada${turnedOff > 1 ? 's' : ''} global${turnedOff > 1 ? 'is' : ''} desligada${turnedOff > 1 ? 's' : ''}.` : ''}`,
    {
      label: 'Desfazer',
      run: async () => {
        await Promise.allSettled(
          [...before].map(([id, on]) =>
            layers.isEnabled(id) === on
              ? null
              : layers.setEnabled(id, on, { origin: 'user' }),
          ),
        );
        camera.cancelFlight?.();
        camera.flyTo({ ...saved, duration: 1.6 });
      },
    },
  );
  return true;
}

async function ensureLayer(id) {
  const layers = deps?.dataManager;
  if (!layers?.layers?.has?.(id)) return null;
  if (!layers.isEnabled(id))
    await layers.setEnabled(id, true, { origin: 'user' }).catch(() => {});
  return layers.layers.get(id)?.module || null;
}

/** Turn on the public cameras and open one (from "Perto de você"). */
export async function openCameraNear(camera) {
  const viewer = deps?.styleManager?.viewer;
  const module = await ensureLayer('cctv');
  // The camera list loads after the layer turns on: try for a few seconds.
  for (let i = 0; i < 12; i += 1) {
    if (module?.selectCamera?.(camera.id, { focus: true })) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  // Not in the loaded set: at least go there.
  viewer?.camera?.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      camera.lon,
      camera.lat - 0.004,
      600,
    ),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
    duration: 1.8,
  });
  return false;
}

/** Turn on traffic incidents and fly to one. */
export async function showIncidentAt(incident) {
  const viewer = deps?.styleManager?.viewer;
  await ensureLayer('traffic-incidents');
  const cam = cityCamera(incident.lat, incident.lon, {
    height: 1800,
    pitchDeg: -60,
  });
  viewer?.camera?.cancelFlight?.();
  viewer?.camera?.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.height),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(cam.pitchDeg),
      roll: 0,
    },
    duration: 1.8,
  });
}
