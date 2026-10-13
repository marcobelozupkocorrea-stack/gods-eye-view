import * as Cesium from 'cesium';
import { INMET_SEVERITY } from '../../data/inmetCap.js';
import {
  INMET_OVERLAY_SOURCE_ID,
  buildInmetCard,
  inmetAccent,
  inmetAnchorDegrees,
} from './cards.js';
export { createInmetAlertSource } from './source.js';
export * from './cards.js';

const PICK_PREFIX = 'inmet-alert:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

const ringPositions = (ring) =>
  ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

/** Own the INMET warning polygons, their refresh and click selection. */
export function createInmetAlertsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('INMET alerts require a snapshot source');
  let _viewer = null;
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

  function publishSelectedCard() {
    if (!canSelect()) return;
    const row = _selectedId ? _rowById.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      overlayHost.setEntries(INMET_OVERLAY_SOURCE_ID, [], CARD_HOST_OPTIONS);
      return;
    }
    overlayHost.setEntries(
      INMET_OVERLAY_SOURCE_ID,
      [
        {
          ...buildInmetCard(row, Date.now()),
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
      const id = pickId.slice(PICK_PREFIX.length).split(':')[0];
      const row = _rowById.get(id);
      if (row && row.severityRank > bestRank) {
        bestRank = row.severityRank;
        bestId = id;
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
      const id = picked ? pickedWarningId(click.position) : null;
      if (id) {
        _selectedId = id;
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
      overlayHost.clearSource(INMET_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(INMET_OVERLAY_SOURCE_ID, false);
    }
  }

  const layer = {
    id: 'inmet-alerts',
    name: 'Alertas INMET',
    icon: '⚠',
    source: 'INMET · Avisos',
    updateInterval: 600000,

    init(viewer) {
      if (_viewer) throw new Error('INMET alert layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('inmet-alerts');
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
      overlayHost?.setVisible?.(INMET_OVERLAY_SOURCE_ID, true);
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
            const color = Cesium.Color.fromCssColorString(inmetAccent(row));
            for (const [index, rings] of row.polygons.entries()) {
              const outer = ringPositions(rings[0]);
              entities.push(
                new Cesium.Entity({
                  id: `${PICK_PREFIX}${row.stableId}:${index}`,
                  polygon: {
                    hierarchy: new Cesium.PolygonHierarchy(outer),
                    material: new Cesium.ColorMaterialProperty(
                      color.withAlpha(0.18),
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
                }),
              );
            }
            const { polygons, ...facts } = row;
            _rowById.set(row.stableId, {
              ...facts,
              anchor: inmetAnchorDegrees(polygons),
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
        console.warn('[Data:InmetAlerts] Fetch error:', e);
        _lastError = e?.message || 'INMET indisponível';
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
          states: row.states,
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
          label: INMET_SEVERITY[grade].label,
          color: INMET_SEVERITY[grade].color,
          count: [..._rowById.values()].filter((row) => row.severity === grade)
            .length,
          ...(index === 0
            ? {
                blurb:
                  'Avisos meteorológicos ativos do INMET. Toque numa área para ver o aviso.',
              }
            : {}),
        })),
      };
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
  return layer;
}
