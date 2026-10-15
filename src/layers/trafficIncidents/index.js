/**
 * barreto.top: live traffic incidents (TomTom) for the area on screen —
 * accidents, closures, road works, stalled vehicles, flooding. Each one is
 * an icon plus the affected stretch; tapping opens its card.
 */
import * as Cesium from 'cesium';

export const INCIDENT_ICONS = Object.freeze({
  acidente: ['💥', '#ff3b30'],
  bloqueio: ['⛔', '#b3261e'],
  obra: ['🚧', '#ff9f0a'],
  faixa: ['↔️', '#ff9f0a'],
  congestionamento: ['🚗', '#ff6b00'],
  alagamento: ['🌊', '#0a84ff'],
  chuva: ['🌧️', '#0a84ff'],
  neblina: ['🌫️', '#8e8e93'],
  gelo: ['❄️', '#64d2ff'],
  vento: ['💨', '#8e8e93'],
  quebrado: ['🛠️', '#ffd60a'],
  perigo: ['⚠️', '#ffd60a'],
  outro: ['ℹ️', '#8e8e93'],
});

/** Line colour by TomTom delay magnitude (0 unknown … 4 standstill). */
export const DELAY_COLORS = Object.freeze([
  '#8e8e93',
  '#ffd60a',
  '#ff9f0a',
  '#ff3b30',
  '#b3261e',
]);

const iconCache = new Map();
function iconFor(kind) {
  if (iconCache.has(kind)) return iconCache.get(kind);
  const [glyph, color] = INCIDENT_ICONS[kind] || INCIDENT_ICONS.outro;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(32, 32, 28, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.font =
    '30px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, 32, 34);
  iconCache.set(kind, canvas);
  return canvas;
}

/** The camera's view as [w, s, e, n], or null. */
export function viewBbox(viewer) {
  try {
    const rect = viewer.camera.computeViewRectangle(
      viewer.scene.globe.ellipsoid,
    );
    if (!rect) return null;
    return [rect.west, rect.south, rect.east, rect.north].map((v) =>
      Number(Cesium.Math.toDegrees(v).toFixed(3)),
    );
  } catch {
    return null;
  }
}

export function createTrafficIncidentsLayer({
  fetchImpl = (...a) => globalThis.fetch(...a),
} = {}) {
  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let request = null;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;
  let items = [];
  let removeMoveEnd = null;
  let moveTimer = 0;

  async function load() {
    if (!enabled || !viewer || !dataSource) return false;
    const bbox = viewBbox(viewer);
    if (!bbox) {
      lastError = 'Aproxime o mapa para ver as ocorrências';
      return false;
    }
    request?.abort();
    const controller = new AbortController();
    request = controller;
    try {
      const res = await fetchImpl(
        `/api/br/ocorrencias?bbox=${bbox.join(',')}`,
        {
          signal: controller.signal,
          credentials: 'same-origin',
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (controller.signal.aborted || !enabled) return false;
      if (body.semChave) lastError = 'Precisa da chave do TomTom no servidor';
      else if (body.tooWide)
        lastError = 'Aproxime o mapa (uns 150 km) para ver as ocorrências';
      else if (body.budgetOut)
        lastError = 'Limite diário de consultas do TomTom atingido';
      else lastError = null;
      if (!body.tooWide) draw(Array.isArray(body.items) ? body.items : []);
      lastUpdate = Date.now();
      return true;
    } catch (err) {
      if (controller.signal.aborted) return false;
      lastError = 'Ocorrências indisponíveis agora';
      console.warn('[ocorrencias]', err?.message || err);
      return false;
    } finally {
      if (request === controller) request = null;
    }
  }

  function draw(list) {
    items = list;
    dataSource.entities.suspendEvents();
    dataSource.entities.removeAll();
    for (const item of list) {
      const id = `incidente:${item.id}`;
      dataSource.entities.add({
        id,
        name: item.label,
        position: Cesium.Cartesian3.fromDegrees(item.lon, item.lat),
        billboard: {
          image: iconFor(item.kind),
          width: 30,
          height: 30,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(2_000, 1.1, 200_000, 0.6),
        },
        properties: { barreto: item },
      });
      if (item.line?.length > 1)
        dataSource.entities.add({
          id: `${id}:linha`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(item.line.flat()),
            width: item.kind === 'bloqueio' ? 7 : 5,
            material:
              item.kind === 'bloqueio'
                ? new Cesium.PolylineDashMaterialProperty({
                    color: Cesium.Color.fromCssColorString(DELAY_COLORS[4]),
                    dashLength: 14,
                  })
                : Cesium.Color.fromCssColorString(
                    DELAY_COLORS[item.magnitude] || DELAY_COLORS[0],
                  ).withAlpha(0.85),
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
          },
          properties: { barreto: item },
        });
    }
    dataSource.entities.resumeEvents();
    count = list.length;
    viewer?.scene?.requestRender?.();
  }

  return {
    id: 'traffic-incidents',
    name: 'Ocorrências de trânsito',
    icon: '🚧',
    source: 'TomTom · ao vivo',
    updateInterval: 3 * 60_000,

    init(v) {
      viewer = v;
      dataSource = new Cesium.CustomDataSource('traffic-incidents');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
    },
    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      if (!removeMoveEnd && viewer?.camera?.moveEnd)
        removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
          clearTimeout(moveTimer);
          moveTimer = setTimeout(() => void load(), 900);
        });
    },
    disable() {
      enabled = false;
      request?.abort();
      clearTimeout(moveTimer);
      removeMoveEnd?.();
      removeMoveEnd = null;
      if (dataSource) {
        dataSource.show = false;
        dataSource.entities.removeAll();
      }
      count = 0;
      items = [];
    },
    update() {
      return load();
    },
    destroy(v = viewer) {
      this.disable();
      if (dataSource && v && !v.isDestroyed?.())
        v.dataSources.remove(dataSource, true);
      dataSource = null;
      viewer = null;
    },
    /** Incidents currently drawn (for the details card and the route view). */
    getItems() {
      return items.slice();
    },
    getStats() {
      return { count, lastUpdate, error: lastError };
    },
  };
}
