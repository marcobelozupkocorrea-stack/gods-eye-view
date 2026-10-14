/**
 * barreto.top: point-event layers for Brazil (DETER deforestation alerts,
 * Cemaden risk alerts). One PointPrimitiveCollection per layer — thousands
 * of points stay cheap — with click selection opening a Portuguese card.
 */
import * as Cesium from 'cesium';
import { CEMADEN_LEVELS } from '../../data/cemaden.js';
import {
  CEMADEN_OVERLAY_SOURCE_ID,
  DETER_OVERLAY_SOURCE_ID,
  buildCemadenCard,
  buildDeterCard,
  cemadenPixelSize,
  deterPixelSize,
} from './cards.js';
export * from './cards.js';

const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

export { createCemadenSource, createDeterSource } from './source.js';

/** INPE DETER deforestation / degradation alerts (last 30 days). */
export function createDeterLayer(options = {}) {
  return createPointEventsLayer({
    id: 'deter-alerts',
    name: 'Desmatamento DETER',
    icon: '🌳',
    sourceLabel: 'INPE · DETER',
    overlaySourceId: DETER_OVERLAY_SOURCE_ID,
    buildCard: buildDeterCard,
    pixelSize: deterPixelSize,
    updateInterval: 3 * 60 * 60_000,
    blurb:
      'Alertas de desmatamento e degradação do INPE (DETER) dos últimos 30 dias, na Amazônia e no Cerrado. Toque num ponto para ver o alerta.',
    legend: [
      {
        label: 'Desmatamento',
        color: '#ff3b30',
        match: (r) => r.className.startsWith('DESMATAMENTO'),
      },
      {
        label: 'Degradação / corte seletivo',
        color: '#ff9f0a',
        match: (r) =>
          r.className === 'DEGRADACAO' || r.className.startsWith('CS_'),
      },
      {
        label: 'Cicatriz de queimada',
        color: '#ffd60a',
        match: (r) => r.className === 'CICATRIZ_DE_QUEIMADA',
      },
      {
        label: 'Mineração',
        color: '#bf5af2',
        match: (r) => r.className === 'MINERACAO',
      },
    ],
    analystRecord: (row) => ({
      id: row.stableId,
      kind: row.label,
      municipality: row.municipality,
      state: row.uf,
      biome: row.biome,
      areaKm2: row.areaKm2,
      date: row.date,
      lat: row.lat,
      lon: row.lon,
    }),
    ...options,
  });
}

/** Cemaden municipal risk alerts (hydrological, mass movement). */
export function createCemadenLayer(options = {}) {
  return createPointEventsLayer({
    id: 'cemaden-alerts',
    name: 'Alertas Cemaden',
    icon: '⚠',
    sourceLabel: 'Cemaden · Painel de alertas',
    overlaySourceId: CEMADEN_OVERLAY_SOURCE_ID,
    buildCard: buildCemadenCard,
    pixelSize: cemadenPixelSize,
    updateInterval: 5 * 60_000,
    blurb:
      'Alertas municipais do Cemaden para risco hidrológico (enchente, enxurrada, inundação) e movimento de massa. Toque num ponto para ver o alerta.',
    legend: ['Moderado', 'Alto', 'Muito Alto'].map((level) => ({
      label: level,
      color: CEMADEN_LEVELS[level].color,
      match: (r) => r.level === level,
    })),
    analystRecord: (row) => ({
      id: row.stableId,
      event: row.event,
      level: row.level,
      municipality: row.municipality,
      state: row.uf,
      created: row.created,
      updated: row.updated,
      lat: row.lat,
      lon: row.lon,
    }),
    ...options,
  });
}

/** Own one set of coloured event points, their refresh and click selection. */
export function createPointEventsLayer({
  id,
  name,
  icon,
  sourceLabel,
  overlaySourceId,
  buildCard,
  pixelSize = () => 8,
  analystRecord = (row) => ({ id: row.stableId, lat: row.lat, lon: row.lon }),
  legend = [],
  blurb = '',
  updateInterval = 600000,
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError(`${name} requires a snapshot source`);
  const PICK_PREFIX = `${id}:`;
  let _viewer = null;
  let _points = null;
  let _request = null;
  let _signature = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _clickHandler = null;
  let _selectedId = null;
  /** @type {Map<string, object>} */
  const _rowById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _rowById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      overlayHost.setEntries(overlaySourceId, [], CARD_HOST_OPTIONS);
      return;
    }
    overlayHost.setEntries(
      overlaySourceId,
      [
        {
          ...buildCard(row, Date.now()),
          position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
        },
      ],
      CARD_HOST_OPTIONS,
    );
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const picked = _viewer.scene.pick(click.position);
      const pickId = picked ? picking.resolvePickId(picked) : null;
      if (pickId && String(pickId).startsWith(PICK_PREFIX)) {
        const rowId = String(pickId).slice(PICK_PREFIX.length);
        if (_rowById.has(rowId)) {
          _selectedId = rowId;
          publishSelectedCard();
          return;
        }
      }
      if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
  }

  function clearSelection() {
    _selectedId = null;
    if (overlayHost) {
      overlayHost.clearSource(overlaySourceId);
      overlayHost.setVisible?.(overlaySourceId, false);
    }
  }

  const outline = Cesium.Color.BLACK.withAlpha(0.7);

  const layer = {
    id,
    name,
    icon,
    source: sourceLabel,
    updateInterval,

    init(viewer) {
      if (_viewer) throw new Error(`${name} layer is already initialized`);
      _viewer = viewer;
      _points = viewer.scene.primitives.add(
        new Cesium.PointPrimitiveCollection(),
      );
      _points.show = false;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
    },

    enable() {
      _enabled = true;
      if (_points) _points.show = true;
      overlayHost?.setVisible?.(overlaySourceId, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_points) _points.show = false;
      removeClickHandler();
      clearSelection();
    },

    async update() {
      if (!_enabled || !_points) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const signature = rows
          .map((row) => `${row.stableId}:${row.updated ?? row.date ?? ''}`)
          .join('|');
        if (signature !== _signature) {
          _points.removeAll();
          _rowById.clear();
          // Least important first, so the most severe draw on top.
          const ordered = [...rows].sort(
            (a, b) => (a.rank ?? 0) - (b.rank ?? 0),
          );
          for (const row of ordered) {
            if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon))
              continue;
            _rowById.set(row.stableId, row);
            _points.add({
              id: `${PICK_PREFIX}${row.stableId}`,
              position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
              color: Cesium.Color.fromCssColorString(row.color || '#ffffff'),
              pixelSize: pixelSize(row),
              outlineColor: outline,
              outlineWidth: 1,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            });
          }
          _signature = signature;
        }
        if (_selectedId) publishSelectedCard();
        _count = _rowById.size;
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn(`[Data:${id}] Fetch error:`, e);
        _lastError = e?.message || 'Fonte indisponível';
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearSelection();
      _rowById.clear();
      _signature = null;
      if (_points && viewer && !viewer.isDestroyed?.()) {
        viewer.scene.primitives.remove(_points);
      }
      _points = null;
      _viewer = null;
      _enabled = false;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /** Event facts for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_points || !_points.show) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const row of _rowById.values()) {
        if (result.length >= limit) break;
        result.push(analystRecord(row));
      }
      return result;
    },

    getRowControls() {
      const rows = [..._rowById.values()];
      return {
        chips: [],
        legend: legend.map((entry, index) => ({
          label: entry.label,
          color: entry.color,
          count: rows.filter(entry.match).length,
          ...(index === 0 && blurb ? { blurb } : {}),
        })),
      };
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
  return layer;
}
