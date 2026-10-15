/**
 * barreto.top: "Minhas áreas" — a named place with a radius (e.g. "5 km em
 * volta de casa"). Areas feed the notifications, the morning summary and
 * the "Perto de você" card, and are outlined on the map. Kept per person on
 * the server (/api/br/areas).
 */
import * as Cesium from 'cesium';
import { openFormSheet } from './formSheet.js';

let areas = null;
const listeners = new Set();
const emit = () => {
  for (const fn of listeners) {
    try {
      fn(areas);
    } catch {
      /* keep going */
    }
  }
};

async function request(method, body) {
  const res = await fetch('/api/br/areas', {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function loadAreas() {
  if (areas) return areas;
  try {
    const data = await request('GET');
    areas = Array.isArray(data?.areas) ? data.areas : [];
  } catch {
    areas = [];
  }
  emit();
  return areas;
}

export async function saveAreas(list) {
  const data = await request('PUT', { areas: list });
  areas = Array.isArray(data?.areas) ? data.areas : [];
  emit();
  return areas;
}

export function onAreas(fn) {
  listeners.add(fn);
  if (areas) fn(areas);
  return () => listeners.delete(fn);
}

/** Viewer of the overlay (set by installAreasOverlay), for the preview. */
let previewViewer = () => null;
let previewEntity = null;

function clearPreview() {
  const viewer = previewViewer();
  if (previewEntity && viewer && !viewer.isDestroyed?.())
    viewer.entities.remove(previewEntity);
  previewEntity = null;
  viewer?.scene?.requestRender?.();
}

/** Draw (or move) the dashed circle of the area being created. */
function showPreview(lat, lon, raioKm) {
  const viewer = previewViewer();
  if (!viewer || viewer.isDestroyed?.()) return;
  const positions = circle(lat, lon, raioKm);
  if (!previewEntity) {
    previewEntity = viewer.entities.add({
      id: 'area:__nova__',
      polyline: {
        positions,
        width: 3,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString('#ffd60a'),
          dashLength: 14,
        }),
        clampToGround: true,
        classificationType: Cesium.ClassificationType.BOTH,
      },
    });
  } else previewEntity.polyline.positions = positions;
  viewer.scene?.requestRender?.();
}

/** Frame the circle in the part of the screen the sheet leaves free. */
function frameCircle(lat, lon, raioKm) {
  const viewer = previewViewer();
  if (!viewer?.camera) return;
  const dLat = raioKm / 111;
  const dLon = raioKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const phone = globalThis.matchMedia?.('(max-width: 720px)')?.matches;
  // On phones the sheet covers the lower half: leave room below the circle.
  const south = lat - dLat * (phone ? 3.4 : 1.4);
  viewer.camera.cancelFlight?.();
  viewer.camera.flyTo({
    destination: Cesium.Rectangle.fromDegrees(
      lon - dLon * 1.3,
      south,
      lon + dLon * 1.3,
      lat + dLat * 1.4,
    ),
    duration: 0.9,
  });
}

/** Ask for a name and radius in a sheet (with a live circle), then save. */
export async function promptNewArea(place) {
  await loadAreas();
  let frameTimer = 0;
  const values = await openFormSheet({
    title: 'Nova área de interesse',
    intro:
      'Avisos, "Perto de você" e o resumo da manhã passam a valer para tudo dentro do círculo.',
    fields: [
      {
        name: 'nome',
        label: 'Nome',
        value:
          place.name && !/^(Ponto no mapa|Este ponto)$/i.test(place.name)
            ? place.name
            : '',
        placeholder: 'Casa, Litoral, Trabalho…',
        maxLength: 40,
        required: true,
      },
      {
        name: 'raioKm',
        label: 'Raio',
        type: 'range',
        min: 1,
        max: 100,
        value: 5,
        unit: 'km',
        presets: [2, 5, 10, 25, 50],
      },
    ],
    submitLabel: 'Criar área',
    onChange: ({ raioKm }) => {
      showPreview(place.lat, place.lon, raioKm);
      clearTimeout(frameTimer);
      frameTimer = setTimeout(
        () => frameCircle(place.lat, place.lon, raioKm),
        350,
      );
    },
  });
  clearTimeout(frameTimer);
  clearPreview();
  if (!values) return null;
  const nome = values.nome.slice(0, 40);
  const raioKm = Math.max(1, Math.min(100, Math.round(values.raioKm) || 5));
  const rest = (areas || []).filter(
    (a) => a.nome.toLowerCase() !== nome.toLowerCase(),
  );
  return saveAreas([{ nome, lat: place.lat, lon: place.lon, raioKm }, ...rest]);
}

export const removeArea = async (nome) => {
  await loadAreas();
  return saveAreas((areas || []).filter((a) => a.nome !== nome));
};

/** Thin dashed circles for every area, with its name on hover/tap. */
export function installAreasOverlay({ styleManager, signal } = {}) {
  previewViewer = () => styleManager?.viewer || null;
  let entities = [];
  const draw = (list) => {
    const viewer = styleManager?.viewer;
    if (!viewer || viewer.isDestroyed?.()) return;
    for (const e of entities) viewer.entities.remove(e);
    entities = [];
    for (const a of list || []) {
      entities.push(
        viewer.entities.add({
          id: `area:${a.nome}`,
          name: `Área: ${a.nome} (${a.raioKm} km)`,
          position: Cesium.Cartesian3.fromDegrees(a.lon, a.lat),
          ellipse: {
            semiMajorAxis: a.raioKm * 1000,
            semiMinorAxis: a.raioKm * 1000,
            material:
              Cesium.Color.fromCssColorString('#39d0ff').withAlpha(0.06),
            outline: false,
            classificationType: Cesium.ClassificationType.BOTH,
          },
        }),
        viewer.entities.add({
          id: `area:${a.nome}:borda`,
          polyline: {
            positions: circle(a.lat, a.lon, a.raioKm),
            width: 2,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString('#39d0ff').withAlpha(0.85),
              dashLength: 16,
            }),
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
          },
        }),
      );
    }
    viewer.scene?.requestRender?.();
  };
  const off = onAreas(draw);
  const retry = setInterval(() => {
    if (styleManager?.viewer) {
      clearInterval(retry);
      void loadAreas();
    }
  }, 1500);
  signal?.addEventListener('abort', () => {
    clearInterval(retry);
    off();
    draw([]);
  });
}

/** Circle as ground positions (72 segments). */
export function circle(lat, lon, radiusKm, steps = 72) {
  const out = [];
  const dLat = radiusKm / 111;
  const dLon =
    radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    out.push(lon + dLon * Math.cos(t), lat + dLat * Math.sin(t));
  }
  return Cesium.Cartesian3.fromDegreesArray(out);
}
