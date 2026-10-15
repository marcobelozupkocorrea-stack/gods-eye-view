/**
 * barreto.top: real city buses (GPS) in the cities that publish them openly —
 * Rio de Janeiro (buses + BRT), Distrito Federal, Belo Horizonte and, with a
 * SPTrans token on the server, São Paulo. Shown when the map is close enough
 * to a city; refreshed every 30 seconds (every 15 s while following one).
 *
 * Params (dataManager.setLayerParams('city-buses', …)):
 *   { linha: '474' }    only that line, in the whole city, plus its route as
 *                       the server has seen it (positions of its buses)
 *   { seguir: 'rio:X' } follow one vehicle: camera, trail, faster refresh
 * Either can be null to clear it.
 */
import * as Cesium from 'cesium';

const COLORS = { Ônibus: '#ffb020', BRT: '#ff5a36' };
const FOLLOW_COLOR = '#39d0ff';
const iconCache = new Map();

/** A round marker with a heading notch (rotated by the billboard). */
function busIcon(modo, moving, color = COLORS[modo] || COLORS.Ônibus) {
  const key = `${color}|${moving}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const c = document.createElement('canvas');
  c.width = 40;
  c.height = 40;
  const ctx = c.getContext('2d');
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

const CITY_SHORT = { rio: 'Rio', df: 'DF', bh: 'BH', sp: 'SP' };

/** Panel text: how many buses each city is sending right now. */
export function citySummary(cities) {
  const parts = [];
  for (const c of cities || []) {
    if (c.status === 'ok')
      parts.push(
        `${CITY_SHORT[c.id] || c.nome} ${c.total.toLocaleString('pt-BR')}`,
      );
    else if (c.status === 'sem_chave')
      parts.push(`${CITY_SHORT[c.id] || c.nome}: precisa de token`);
    else if (c.status === 'falhou')
      parts.push(`${CITY_SHORT[c.id] || c.nome}: sem resposta`);
  }
  return parts.length
    ? `GPS real: ${parts.join(' · ')}`
    : 'GPS real de Rio, Brasília, BH (e SP com token). Aproxime de uma dessas cidades.';
}

export function createBusesLayer({
  fetchImpl = (...a) => globalThis.fetch(...a),
} = {}) {
  let viewer = null;
  let collection = null;
  let routeDots = null;
  let trailEntity = null;
  let enabled = false;
  let request = null;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;
  let cities = [];
  let items = [];
  let linesOnScreen = [];
  let removeMoveEnd = null;
  let moveTimer = 0;
  let followTimer = 0;
  let params = { linha: null, seguir: null };

  const itemById = (id) => items.find((b) => b.id === id) || null;

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
    const q = new URLSearchParams({ bbox: bbox.join(',') });
    if (params.linha) q.set('linha', params.linha);
    if (params.seguir) q.set('seguir', params.seguir);
    try {
      const res = await fetchImpl(`/api/br/onibus?${q}`, {
        signal: controller.signal,
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (controller.signal.aborted || !enabled) return false;
      cities = Array.isArray(body.cidades) ? body.cidades : [];
      linesOnScreen = Array.isArray(body.linhasNaTela) ? body.linhasNaTela : [];
      const list = Array.isArray(body.items) ? body.items : [];
      if (body.tooWide) {
        lastError =
          'Aproxime de Rio, Brasília, BH ou São Paulo para ver os ônibus';
        draw([]);
        drawRoute([]);
      } else {
        draw(list);
        drawRoute(params.linha ? body.trajeto || [] : []);
        const visible = (c) =>
          bbox[0] <= c.bbox[2] &&
          bbox[2] >= c.bbox[0] &&
          bbox[1] <= c.bbox[3] &&
          bbox[3] >= c.bbox[1];
        const failed = cities.filter(
          (c) => c.status === 'falhou' && visible(c),
        );
        const noKey = cities.find(
          (c) => c.status === 'sem_chave' && visible(c),
        );
        lastError = failed.length
          ? `Sem resposta agora: ${failed.map((c) => c.nome).join(', ')}`
          : noKey
            ? `${noKey.nome}: precisa do token gratuito da SPTrans no servidor`
            : list.length
              ? null
              : params.linha
                ? `Nenhum ônibus da linha ${params.linha} transmitindo agora`
                : 'Nenhum ônibus com GPS aberto nesta área';
      }
      if (params.seguir) follow(body.rastro || []);
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

  function draw(list) {
    items = list;
    collection.removeAll();
    for (const b of list) {
      const moving = Number.isFinite(b.dir) && (b.vel ?? 1) > 2;
      const followed = b.id === params.seguir;
      collection.add({
        id: pickTarget(b),
        position: Cesium.Cartesian3.fromDegrees(b.lon, b.lat, 4),
        image: busIcon(b.modo, moving, followed ? FOLLOW_COLOR : undefined),
        width: followed ? 30 : 22,
        height: followed ? 30 : 22,
        rotation: moving ? -Cesium.Math.toRadians(b.dir) : 0,
        alignedAxis: moving ? Cesium.Cartesian3.UNIT_Z : Cesium.Cartesian3.ZERO,
        disableDepthTestDistance: 50_000,
        scaleByDistance: new Cesium.NearFarScalar(1_500, 1.2, 120_000, 0.45),
      });
    }
    count = list.length;
    viewer?.scene?.requestRender?.();
  }

  /** The line's route as its buses have been seen (dots, unordered). */
  function drawRoute(points) {
    routeDots?.removeAll();
    if (!points.length) return;
    if (!routeDots) {
      routeDots = new Cesium.PointPrimitiveCollection();
      viewer.scene.primitives.add(routeDots);
    }
    const color = Cesium.Color.fromCssColorString('#ffb020').withAlpha(0.55);
    for (const [lon, lat] of points)
      routeDots.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat, 2),
        pixelSize: 4,
        color,
        disableDepthTestDistance: 50_000,
      });
    viewer?.scene?.requestRender?.();
  }

  function clearTrail() {
    if (trailEntity && viewer && !viewer.isDestroyed?.())
      viewer.entities.remove(trailEntity);
    trailEntity = null;
  }

  /** Keep the followed bus in view and draw where it has been. */
  function follow(track) {
    const bus = itemById(params.seguir);
    if (!bus) {
      lastError = 'O ônibus acompanhado parou de transmitir';
      return;
    }
    const points = track.length ? track : [[bus.lon, bus.lat]];
    clearTrail();
    if (points.length > 1)
      trailEntity = viewer.entities.add({
        id: `onibus-rastro:${bus.id}`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(
            points.flatMap(([x, y]) => [x, y]),
          ),
          width: 4,
          material: new Cesium.PolylineGlowMaterialProperty({
            color: Cesium.Color.fromCssColorString(FOLLOW_COLOR),
            glowPower: 0.18,
          }),
          clampToGround: true,
        },
      });
    const camera = viewer.camera;
    const height = Math.min(
      6000,
      Math.max(900, camera.positionCartographic?.height || 2500),
    );
    camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(bus.lon, bus.lat, height),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 1.4,
    });
  }

  function syncFollowTimer() {
    clearInterval(followTimer);
    followTimer = 0;
    if (enabled && params.seguir)
      followTimer = setInterval(() => void load(), 15_000);
  }

  const openFilter = () =>
    globalThis.dispatchEvent?.(
      new CustomEvent('barreto:buses-filter', {
        detail: { linha: params.linha, sugestoes: linesOnScreen.slice() },
      }),
    );

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
      if (routeDots) routeDots.show = true;
      if (!removeMoveEnd && viewer?.camera?.moveEnd)
        removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
          // While following, our own flights move the camera: no reload loop.
          if (params.seguir) return;
          clearTimeout(moveTimer);
          moveTimer = setTimeout(() => void load(), 800);
        });
      syncFollowTimer();
    },
    disable() {
      enabled = false;
      request?.abort();
      clearTimeout(moveTimer);
      removeMoveEnd?.();
      removeMoveEnd = null;
      params = { linha: null, seguir: null };
      syncFollowTimer();
      if (collection) {
        collection.show = false;
        collection.removeAll();
      }
      routeDots?.removeAll();
      clearTrail();
      count = 0;
      items = [];
    },
    update() {
      return load();
    },
    destroy(v = viewer) {
      this.disable();
      if (collection && v && !v.isDestroyed?.())
        v.scene.primitives.remove(collection);
      if (routeDots && v && !v.isDestroyed?.())
        v.scene.primitives.remove(routeDots);
      collection = null;
      routeDots = null;
      viewer = null;
    },
    /** { linha?: string|null, seguir?: string|null } */
    setParams(next = {}) {
      const clean = (v, max) =>
        v == null || v === '' ? null : String(v).trim().slice(0, max) || null;
      const before = `${params.linha}|${params.seguir}`;
      if ('linha' in next) params.linha = clean(next.linha, 20);
      if ('seguir' in next) params.seguir = clean(next.seguir, 60);
      if (!params.seguir) clearTrail();
      syncFollowTimer();
      if (`${params.linha}|${params.seguir}` !== before && enabled) void load();
      return true;
    },
    getParams() {
      return { ...params };
    },
    /** Latest record of a bus on screen (the details sheet stays current). */
    getItem(id) {
      return itemById(id);
    },
    getCities() {
      return cities.slice();
    },
    getRowControls() {
      const chips = [
        {
          id: 'filtro',
          label: params.linha ? `Linha ${params.linha} ✕` : 'Filtrar linha',
          active: Boolean(params.linha),
          ...(params.linha
            ? { params: { linha: null } }
            : { onClick: openFilter }),
        },
      ];
      if (params.linha)
        chips.push({ id: 'trocar', label: 'Outra linha', onClick: openFilter });
      if (params.seguir)
        chips.push({
          id: 'seguir',
          label: 'Parar de acompanhar',
          active: true,
          params: { seguir: null },
        });
      return {
        chips,
        info: params.linha
          ? `Linha ${params.linha}: ${count} ônibus agora. Pontos claros = trajeto montado com as posições reais vistas nas últimas horas.`
          : citySummary(cities),
      };
    },
    getStats() {
      return { count, lastUpdate, error: lastError };
    },
  };
}
