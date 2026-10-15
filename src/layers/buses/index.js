/**
 * barreto.top: real city buses (GPS) in the cities that publish them openly —
 * Rio de Janeiro (buses + BRT), Distrito Federal, Belo Horizonte and, with a
 * SPTrans token on the server, São Paulo. Shown when the map is close enough
 * to a city; refreshed every 30 seconds.
 */
import * as Cesium from 'cesium';

const COLORS = { Ônibus: '#ffb020', BRT: '#ff5a36' };
const iconCache = new Map();

/** A round marker with a heading notch (rotated by the billboard). */
function busIcon(modo, moving) {
  const key = `${modo}|${moving}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const c = document.createElement('canvas');
  c.width = 40;
  c.height = 40;
  const ctx = c.getContext('2d');
  const color = COLORS[modo] || COLORS.Ônibus;
  if (moving) {
    ctx.beginPath();
    ctx.moveTo(20, 1);
    ctx.lineTo(27, 11);
    ctx.lineTo(13, 11);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(20, 22, 11, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.stroke();
  ctx.fillStyle = '#1c1c1e';
  ctx.fillRect(14, 17, 12, 8);
  ctx.fillStyle = color;
  ctx.fillRect(15.5, 18.5, 9, 3);
  iconCache.set(key, c);
  return c;
}

function viewBbox(viewer) {
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

/** Pick target in the shape the details sheet reads (id + properties). */
const pickTarget = (record) => ({
  id: `onibus:${record.id}`,
  properties: { barreto: { getValue: () => record } },
});

export function createBusesLayer({
  fetchImpl = (...a) => globalThis.fetch(...a),
} = {}) {
  let viewer = null;
  let collection = null;
  let enabled = false;
  let request = null;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;
  let cities = [];
  let removeMoveEnd = null;
  let moveTimer = 0;

  async function load() {
    if (!enabled || !viewer || !collection) return false;
    const bbox = viewBbox(viewer);
    if (!bbox) {
      lastError = 'Aproxime o mapa de uma cidade';
      return false;
    }
    request?.abort();
    const controller = new AbortController();
    request = controller;
    try {
      const res = await fetchImpl(`/api/br/onibus?bbox=${bbox.join(',')}`, {
        signal: controller.signal,
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (controller.signal.aborted || !enabled) return false;
      cities = Array.isArray(body.cidades) ? body.cidades : [];
      const items = Array.isArray(body.items) ? body.items : [];
      if (body.tooWide) {
        lastError =
          'Aproxime de Rio, Brasília, BH ou São Paulo para ver os ônibus';
        draw([]);
      } else {
        draw(items);
        const failed = cities.filter(
          (c) =>
            c.status === 'falhou' &&
            bbox[0] <= c.bbox[2] &&
            bbox[2] >= c.bbox[0] &&
            bbox[1] <= c.bbox[3] &&
            bbox[3] >= c.bbox[1],
        );
        const noKey = cities.find(
          (c) =>
            c.status === 'sem_chave' &&
            bbox[0] <= c.bbox[2] &&
            bbox[2] >= c.bbox[0] &&
            bbox[1] <= c.bbox[3] &&
            bbox[3] >= c.bbox[1],
        );
        lastError = failed.length
          ? `Sem resposta agora: ${failed.map((c) => c.nome).join(', ')}`
          : noKey
            ? `${noKey.nome}: precisa do token gratuito da SPTrans no servidor`
            : items.length
              ? null
              : 'Nenhum ônibus com GPS aberto nesta área';
      }
      lastUpdate = Date.now();
      return true;
    } catch (err) {
      if (controller.signal.aborted) return false;
      lastError = 'Ônibus indisponíveis agora';
      console.warn('[onibus]', err?.message || err);
      return false;
    } finally {
      if (request === controller) request = null;
    }
  }

  function draw(items) {
    collection.removeAll();
    for (const b of items) {
      const moving = Number.isFinite(b.dir) && (b.vel ?? 1) > 2;
      collection.add({
        id: pickTarget(b),
        position: Cesium.Cartesian3.fromDegrees(b.lon, b.lat, 4),
        image: busIcon(b.modo, moving),
        width: 22,
        height: 22,
        rotation: moving ? -Cesium.Math.toRadians(b.dir) : 0,
        alignedAxis: moving ? Cesium.Cartesian3.UNIT_Z : Cesium.Cartesian3.ZERO,
        disableDepthTestDistance: 50_000,
        scaleByDistance: new Cesium.NearFarScalar(1_500, 1.2, 120_000, 0.45),
      });
    }
    count = items.length;
    viewer?.scene?.requestRender?.();
  }

  return {
    id: 'city-buses',
    name: 'Ônibus em tempo real',
    icon: '🚌',
    source: 'GPS aberto das prefeituras',
    updateInterval: 30_000,

    init(v) {
      viewer = v;
      collection = new Cesium.BillboardCollection({ scene: viewer.scene });
      collection.show = false;
      viewer.scene.primitives.add(collection);
    },
    enable() {
      enabled = true;
      if (collection) collection.show = true;
      if (!removeMoveEnd && viewer?.camera?.moveEnd)
        removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
          clearTimeout(moveTimer);
          moveTimer = setTimeout(() => void load(), 800);
        });
    },
    disable() {
      enabled = false;
      request?.abort();
      clearTimeout(moveTimer);
      removeMoveEnd?.();
      removeMoveEnd = null;
      if (collection) {
        collection.show = false;
        collection.removeAll();
      }
      count = 0;
    },
    update() {
      return load();
    },
    destroy(v = viewer) {
      this.disable();
      if (collection && v && !v.isDestroyed?.())
        v.scene.primitives.remove(collection);
      collection = null;
      viewer = null;
    },
    /** Status of each city feed (for the panel text). */
    getCities() {
      return cities.slice();
    },
    getStats() {
      return { count, lastUpdate, error: lastError };
    },
  };
}
