import * as Cesium from 'cesium';
import { CAP_SEVERITY } from '../../data/capAlerts.js';
import { INMET_SEVERITY } from '../../data/inmetCap.js';
import {
  DEFESA_CIVIL_OVERLAY_SOURCE_ID,
  INMET_OVERLAY_SOURCE_ID,
  alertAccent,
  alertAnchorDegrees,
  buildAlertCard,
  buildInmetCard,
} from './cards.js';
export {
  createInmetAlertSource,
  createDefesaCivilAlertSource,
} from './source.js';
export * from './cards.js';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

const ringPositions = (ring) =>
  ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

/** INMET weather warnings (Brazil). */
/** Warning fill by camera height: visible from afar, faint over a city. */
export const FILL_ALPHA = Object.freeze({ far: 0.18, mid: 0.1, near: 0.035 });
export function fillBandFor(height) {
  if (!Number.isFinite(height) || height > 200_000) return 'far';
  return height > 40_000 ? 'mid' : 'near';
}

export function createInmetAlertsLayer(options = {}) {
  return createCapAlertsLayer({
    id: 'inmet-alerts',
    name: 'Alertas INMET',
    icon: '⚠',
    sourceLabel: 'INMET · Avisos',
    overlaySourceId: INMET_OVERLAY_SOURCE_ID,
    scale: INMET_SEVERITY,
    buildCard: buildInmetCard,
    blurb:
      'Avisos meteorológicos ativos do INMET. Toque numa área para ver o aviso.',
    ...options,
  });
}

/** Defesa Civil alerts from the national IDAP feed (Brazil). */
export function createDefesaCivilAlertsLayer(options = {}) {
  return createCapAlertsLayer({
    id: 'defesa-civil-alerts',
    name: 'Alertas Defesa Civil',
    icon: '🚨',
    sourceLabel: 'Defesa Civil · IDAP',
    overlaySourceId: DEFESA_CIVIL_OVERLAY_SOURCE_ID,
    scale: CAP_SEVERITY,
    buildCard: (row, now) =>
      buildAlertCard(row, now, {
        idPrefix: 'defesa-civil-card',
        source: 'Defesa Civil',
      }),
    blurb:
      'Alertas emitidos pelas Defesas Civis (IDAP). Toque numa área para ver o alerta.',
    ...options,
  });
}

/** Own one set of CAP warning polygons, their refresh and click selection. */
export function createCapAlertsLayer({
  id,
  name,
  icon,
  sourceLabel,
  overlaySourceId,
  scale = CAP_SEVERITY,
  buildCard = buildAlertCard,
  blurb = '',
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError(`${name} requires a snapshot source`);
  const PICK_PREFIX = `${id}:`;
  const OVERLAY_ID = overlaySourceId;
  let _viewer = null;
  let _fillBand = 'far';
  let _removeCameraWatch = null;
  function applyFillBand() {
    const height = _viewer?.camera?.positionCartographic?.height;
    const band = fillBandFor(height);
    if (band === _fillBand || !_dataSource) return;
    _fillBand = band;
    for (const entity of _dataSource.entities.values)
      if (entity.polygon && entity.barretoFill)
        entity.polygon.material = new Cesium.ColorMaterialProperty(
          entity.barretoFill.withAlpha(FILL_ALPHA[band]),
        );
    _viewer?.scene?.requestRender?.();
  }
  let _request = null;
  let _dataSource = null;
  let _signature = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _clickHandler = null;
  let _selectedId = null;
  /** @type {Map<string, object>} geometry-free rows with a card anchor */
  const _rowById = new Map();

  const canSelect = () =>
    overlayHost && screenSpaceEventHandlerFactory && picking;

  /** barreto.top: tell the pt-BR detail sheet which record is selected. */
  let _announcedId = null;
  function announceSelection(row) {
    const id = row ? String(row.stableId ?? _selectedId) : null;
    if (!row && _announcedId === null) return;
    _announcedId = id;
    globalThis.dispatchEvent?.(
      new CustomEvent(
        row ? 'barreto:record-selected' : 'barreto:record-cleared',
        {
          detail: { layerId: layer.id, id, record: row ? { ...row } : null },
        },
      ),
    );
  }

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _rowById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      overlayHost.setEntries(OVERLAY_ID, [], CARD_HOST_OPTIONS);
      announceSelection(null);
      return;
    }
    announceSelection(row);
    overlayHost.setEntries(
      OVERLAY_ID,
      [
        {
          ...buildCard(row, Date.now()),
          position: Cesium.Cartesian3.fromDegrees(
            row.anchor.lon,
            row.anchor.lat,
          ),
        },
      ],
      CARD_HOST_OPTIONS,
    );
  }

  /** Among overlapping warnings under the cursor, prefer the most severe. */
  function pickedWarningId(position) {
    const picks = _viewer.scene.drillPick(position, 12) || [];
    let bestId = null;
    let bestRank = -1;
    for (const picked of picks) {
      const pickId = picking.resolvePickId(picked);
      if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
        continue;
      const warningId = pickId.slice(PICK_PREFIX.length).split(':')[0];
      const row = _rowById.get(warningId);
      if (row && row.severityRank > bestRank) {
        bestRank = row.severityRank;
        bestId = warningId;
      }
    }
    return bestId;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Not registered in the pick-ownership registry, like fire perimeters:
    // these large ground polygons must not make sibling cards inert.
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const picked = _viewer.scene.pick(click.position);
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (
          pickId &&
          !String(pickId).startsWith(PICK_PREFIX) &&
          picking.isOwnedByOtherLayer(layer.id, pickId)
        )
          return;
      }
      const warningId = picked ? pickedWarningId(click.position) : null;
      if (warningId) {
        _selectedId = warningId;
        publishSelectedCard();
        return;
      }
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
      overlayHost.clearSource(OVERLAY_ID);
      overlayHost.setVisible?.(OVERLAY_ID, false);
    }
  }

  const layer = {
    id,
    name,
    icon,
    source: sourceLabel,
    updateInterval: 600000,

    init(viewer) {
      if (_viewer) throw new Error(`${name} layer is already initialized`);
      _viewer = viewer;
      // barreto.top: up close a big warning polygon would tint the whole
      // street view; the fill fades by camera height, the outline stays.
      _removeCameraWatch = viewer.camera?.changed?.addEventListener?.(() =>
        applyFillBand(),
      );
      _dataSource = new Cesium.CustomDataSource(id);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(OVERLAY_ID, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearSelection();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const signature = rows
          .map((row) => `${row.stableId}:${row.expires}`)
          .sort()
          .join('|');
        if (signature !== _signature) {
          // Least severe first, so the most severe warnings draw on top.
          const ordered = [...rows].sort(
            (a, b) => (a.severityRank ?? 0) - (b.severityRank ?? 0),
          );
          const entities = [];
          _rowById.clear();
          for (const row of ordered) {
            const color = Cesium.Color.fromCssColorString(alertAccent(row));
            for (const [index, rings] of row.polygons.entries()) {
              const outer = ringPositions(rings[0]);
              const entity = new Cesium.Entity({
                id: `${PICK_PREFIX}${row.stableId}:${index}`,
                polygon: {
                  hierarchy: new Cesium.PolygonHierarchy(outer),
                  material: new Cesium.ColorMaterialProperty(
                    color.withAlpha(FILL_ALPHA[_fillBand]),
                  ),
                },
                polyline: {
                  positions: outer,
                  clampToGround: true,
                  width: 2,
                  material: new Cesium.ColorMaterialProperty(
                    color.withAlpha(0.85),
                  ),
                },
              });
              entity.barretoFill = color;
              entities.push(entity);
            }
            const { polygons, ...facts } = row;
            _rowById.set(row.stableId, {
              ...facts,
              anchor: alertAnchorDegrees(polygons),
            });
          }
          _dataSource.entities.removeAll();
          for (const entity of entities) _dataSource.entities.add(entity);
          _signature = signature;
        }
        if (_selectedId) publishSelectedCard();
        _count = rows.length;
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
      _removeCameraWatch?.();
      _removeCameraWatch = null;
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearSelection();
      _rowById.clear();
      _signature = null;
      _viewer = null;
      _enabled = false;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * barreto.top: open the card of one item by its stable id (used by the
     * "Brasil agora" list). Returns false while the item is not loaded yet.
     */
    focusById(stableId) {
      if (!_enabled || !_rowById.has(String(stableId))) return false;
      _selectedId = String(stableId);
      publishSelectedCard();
      return true;
    },

    /** Warning facts with their card anchor, for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const row of _rowById.values()) {
        if (result.length >= limit) break;
        result.push({
          id: row.stableId,
          event: row.event,
          severity: row.severityLabel,
          states: row.states || row.areaDesc,
          issuer: row.senderName,
          onset: row.onset,
          expires: row.expires,
          lat: row.anchor.lat,
          lon: row.anchor.lon,
        });
      }
      return result;
    },

    getRowControls() {
      const grades = ['Moderate', 'Severe', 'Extreme'];
      return {
        chips: [],
        legend: grades.map((grade, index) => ({
          label: scale[grade].label,
          color: scale[grade].color,
          count: [..._rowById.values()].filter((row) => row.severity === grade)
            .length,
          ...(index === 0 ? { blurb } : {}),
        })),
      };
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
  return layer;
}
