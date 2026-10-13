import * as Cesium from 'cesium';
import {
  createDefesaCivilAlertsLayer,
  createInmetAlertsLayer,
} from '../../layers/alerts/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

const appServices = () => ({
  overlayHost: {
    setEntries: overlays.setOverlayEntries,
    setVisible: overlays.setOverlaySourceVisible,
    clearSource: overlays.clearOverlaySource,
    hitTest: overlays.hitTestWorldOverlay,
  },
  screenSpaceEventHandlerFactory: (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
  picking,
  pointer: { isPointerFree },
});

/** Wire INMET weather warnings (Brazil) into the application catalog. */
export function createApplicationInmetAlerts(options) {
  return createInmetAlertsLayer({ ...appServices(), ...options });
}

/** Wire Defesa Civil (IDAP) alerts (Brazil) into the application catalog. */
export function createApplicationDefesaCivilAlerts(options) {
  return createDefesaCivilAlertsLayer({ ...appServices(), ...options });
}
