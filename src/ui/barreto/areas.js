/**
 * barreto.top: "Minhas áreas" — a named place with a radius (e.g. "5 km em
 * volta de casa"). Areas feed the notifications, the morning summary and
 * the "Perto de você" card, and are outlined on the map. Kept per person on
 * the server (/api/br/areas).
 */
import * as Cesium from 'cesium';

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

/** Ask for a name and radius, then save. */
export async function promptNewArea(place) {
  const nome = globalThis.prompt?.(
    'Nome da área (ex.: Casa, Litoral, Trabalho):',
    place.name || '',
  );
  if (!nome || !nome.trim()) return null;
  const raio = Number(
    String(globalThis.prompt?.('Raio em km (1 a 100):', '5') || '').replace(
      ',',
      '.',
    ),
  );
  const raioKm = Number.isFinite(raio)
    ? Math.max(1, Math.min(100, Math.round(raio)))
    : 5;
  await loadAreas();
  const rest = (areas || []).filter(
    (a) => a.nome.toLowerCase() !== nome.trim().toLowerCase(),
  );
  return saveAreas([
    { nome: nome.trim(), lat: place.lat, lon: place.lon, raioKm },
    ...rest,
  ]);
}

export const removeArea = async (nome) => {
  await loadAreas();
  return saveAreas((areas || []).filter((a) => a.nome !== nome));
};

/** Thin dashed circles for every area, with its name on hover/tap. */
export function installAreasOverlay({ styleManager, signal } = {}) {
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
