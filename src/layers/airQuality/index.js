/**
 * barreto.top: air quality in ~120 Brazilian cities — the US AQI index from
 * the Copernicus CAMS model (via Open-Meteo), refreshed hourly. A model
 * estimate on a coarse grid, not station readings; the card says so.
 */
import * as Cesium from 'cesium';

const badgeCache = new Map();
function badge(aqi, color) {
  const key = `${aqi}|${color}`;
  if (badgeCache.has(key)) return badgeCache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = 72;
  canvas.height = 44;
  const ctx = canvas.getContext('2d');
  const r = 20;
  ctx.beginPath();
  ctx.moveTo(r + 2, 2);
  ctx.arcTo(70, 2, 70, 42, r);
  ctx.arcTo(70, 42, 2, 42, r);
  ctx.arcTo(2, 42, 2, 2, r);
  ctx.arcTo(2, 2, 70, 2, r);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();
  ctx.fillStyle =
    aqi > 100 && aqi <= 150 ? '#1c1c1e' : aqi <= 100 ? '#0b0f14' : '#ffffff';
  ctx.font = 'bold 22px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(aqi), 36, 23);
  badgeCache.set(key, canvas);
  return canvas;
}

export function createAirQualityLayer({
  fetchImpl = (...a) => globalThis.fetch(...a),
} = {}) {
  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;
  let worst = null;

  async function load() {
    if (!enabled || !dataSource) return false;
    try {
      const res = await fetchImpl('/api/br/ar', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!enabled) return false;
      const list = Array.isArray(body?.cidades) ? body.cidades : [];
      dataSource.entities.suspendEvents();
      dataSource.entities.removeAll();
      for (const c of list) {
        if (!Number.isFinite(c.lat) || !Number.isFinite(c.aqi)) continue;
        dataSource.entities.add({
          id: `ar:${c.code}`,
          name: `Ar em ${c.nome}`,
          position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat),
          billboard: {
            image: badge(c.aqi, c.cor || '#8e8e93'),
            width: 36,
            height: 22,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(
              50_000,
              1.15,
              4_000_000,
              0.7,
            ),
          },
          properties: { barreto: c },
        });
      }
      dataSource.entities.resumeEvents();
      count = list.length;
      worst = list.reduce((m, c) => (!m || c.aqi > m.aqi ? c : m), null);
      lastUpdate = Date.now();
      lastError = list.length ? null : 'Sem dados de qualidade do ar agora';
      viewer?.scene?.requestRender?.();
      return true;
    } catch (err) {
      lastError = 'Qualidade do ar indisponível agora';
      console.warn('[ar]', err?.message || err);
      return false;
    }
  }

  return {
    id: 'air-quality',
    name: 'Qualidade do ar',
    icon: '🌫️',
    source: 'Copernicus CAMS · Open-Meteo',
    updateInterval: 30 * 60_000,
    init(v) {
      viewer = v;
      dataSource = new Cesium.CustomDataSource('air-quality');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
    },
    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
    },
    disable() {
      enabled = false;
      if (dataSource) {
        dataSource.show = false;
        dataSource.entities.removeAll();
      }
      count = 0;
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
    getStats() {
      return {
        count,
        lastUpdate,
        error: lastError,
        worst: worst
          ? `${worst.nome}/${worst.uf}: ${worst.aqi} (${worst.nivel})`
          : null,
      };
    },
  };
}
