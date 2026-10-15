/**
 * barreto.top: an honest traffic view.
 *
 * TomTom gives the SPEED of the traffic on each road (relative to free
 * flow), not how many vehicles there are. The animated dots are an
 * illustration whose number depends on road length, road type and zoom.
 * The Portuguese build therefore:
 * - draws the roads themselves in the flow colour (real data) and, by
 *   default, no dots ("vias");
 * - offers "vias + fluxo" and "só fluxo" as choices, labelled as
 *   illustrative;
 * - never presents the dots as detected vehicles (no "VEH-0020" brackets).
 * Configured once at startup from shareRestoration.js; upstream behaviour is
 * unchanged when it is not called.
 */
export const TRAFFIC_VIEWS = Object.freeze(['vias', 'ambos', 'pontos']);

export const trafficHonesty = {
  /** Default view; 'pontos' = upstream behaviour (dots only). */
  view: 'pontos',
  /** Hide the dots from detection overlays (no fake vehicle IDs). */
  honest: false,
  /** Portuguese chips, legend and note on the layer row. */
  pt: false,
};

export function configureTrafficForBrazil() {
  trafficHonesty.view = 'vias';
  trafficHonesty.honest = true;
  trafficHonesty.pt = true;
}

export const normalizeTrafficView = (value) =>
  TRAFFIC_VIEWS.includes(value) ? value : null;

/** Road lines wanted for this view? */
export const viewDrawsLines = (view) => view === 'vias' || view === 'ambos';
/** Dots wanted for this view? */
export const viewDrawsDots = (view) => view === 'ambos' || view === 'pontos';
