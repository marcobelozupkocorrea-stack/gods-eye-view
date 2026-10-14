/**
 * barreto.top: "Radar de chuva (Brasil)". Each live CPTEC/INPE weather radar's
 * latest CAPPI 3 km reflectivity image, laid on the ground over the radar's
 * footprint (about 250 km around it). Frames arrive through the same-origin
 * proxy at /api/brazil-radar; areas without a radar show nothing — no echo
 * there does not mean no rain.
 */
import * as Cesium from 'cesium';

const MANIFEST_URL = '/api/brazil-radar/manifest';
const frameUrl = (radar) =>
  `/api/brazil-radar/frame?id=${encodeURIComponent(radar.id)}&stamp=${radar.stamp}`;

/** Keep only well-formed radars from the proxy manifest. */
export function validRadars(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.radars))
    throw new Error('Manifesto de radar inválido');
  return manifest.radars.filter(
    (r) =>
      typeof r?.id === 'string' &&
      /^20\d{10}$/.test(String(r.stamp)) &&
      ['west', 'south', 'east', 'north'].every((k) =>
        Number.isFinite(r.bounds?.[k]),
      ) &&
      r.bounds.west < r.bounds.east &&
      r.bounds.south < r.bounds.north,
  );
}

export function createBrazilRadarLayer({
  fetchImpl = (...args) => globalThis.fetch(...args),
  cesium = Cesium,
} = {}) {
  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let request = null;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;
  let latest = null;
  let radars = [];

  const layer = {
    id: 'brazil-radar',
    name: 'Radar de chuva (Brasil)',
    icon: '☔',
    source: 'CPTEC/INPE · radares',
    updateInterval: 5 * 60_000,

    init(v) {
      viewer = v;
      dataSource = new cesium.CustomDataSource('brazil-radar');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
    },

    disable() {
      enabled = false;
      request?.abort();
      request = null;
      if (dataSource) {
        dataSource.show = false;
        dataSource.entities.removeAll();
      }
      count = 0;
    },

    async update() {
      if (!enabled || !dataSource) return false;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const response = await fetchImpl(MANIFEST_URL, {
          signal: controller.signal,
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`Radar HTTP ${response.status}`);
        const list = validRadars(await response.json());
        if (controller.signal.aborted || !enabled) return false;
        const keep = new Set();
        for (const radar of list) {
          const id = `brazil-radar:${radar.id}`;
          keep.add(id);
          const url = frameUrl(radar);
          const existing = dataSource.entities.getById(id);
          if (existing) {
            if (existing.properties?.frame?.getValue() !== url) {
              existing.rectangle.material = new cesium.ImageMaterialProperty({
                image: url,
                transparent: true,
                color: cesium.Color.WHITE.withAlpha(0.85),
              });
              existing.properties.frame = url;
            }
            continue;
          }
          const { west, south, east, north } = radar.bounds;
          dataSource.entities.add({
            id,
            name: `Radar ${radar.name}`,
            rectangle: {
              coordinates: cesium.Rectangle.fromDegrees(
                west,
                south,
                east,
                north,
              ),
              material: new cesium.ImageMaterialProperty({
                image: url,
                transparent: true,
                color: cesium.Color.WHITE.withAlpha(0.85),
              }),
              classificationType: cesium.ClassificationType.BOTH,
            },
            properties: { frame: url, radar: radar.id },
          });
        }
        for (const entity of [...dataSource.entities.values])
          if (!keep.has(entity.id)) dataSource.entities.remove(entity);
        radars = list;
        count = list.length;
        latest = list.reduce(
          (max, r) => (!max || r.time > max ? r.time : max),
          null,
        );
        lastUpdate = Date.now();
        lastError = list.length ? null : 'Nenhum radar transmitindo agora';
        viewer?.scene?.requestRender?.();
        return true;
      } catch (error) {
        if (controller.signal.aborted) return false;
        lastError = error?.message || 'Radares indisponíveis';
        return false;
      } finally {
        if (request === controller) request = null;
      }
    },

    destroy(v = viewer) {
      request?.abort();
      request = null;
      enabled = false;
      if (dataSource && v && !v.isDestroyed?.())
        v.dataSources.remove(dataSource, true);
      dataSource = null;
      viewer = null;
    },

    /** Radars currently drawn: name, operator and frame time. */
    getRadars() {
      return radars.map(({ id, name, owner, time }) => ({
        id,
        name,
        owner,
        time,
      }));
    },

    getStats() {
      return {
        count,
        lastUpdate,
        error: lastError,
        latest,
      };
    },
  };
  return layer;
}
