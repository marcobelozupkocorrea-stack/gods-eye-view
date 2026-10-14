/**
 * barreto.top: lighter rendering on phones and low-memory devices.
 *
 * A touch device with a small screen, or one reporting ≤ 4 GB of memory,
 * gets no MSAA and a smaller, coarser Google 3D tile budget: tiles arrive
 * sooner, frames stay smoother and the tab is less likely to be evicted.
 * Desktops keep the shipped quality.
 */
export function isConstrainedDevice(g = globalThis) {
  try {
    const coarse = Boolean(g.matchMedia?.('(pointer: coarse)')?.matches);
    const shortSide = Math.min(
      Number(g.screen?.width) || Infinity,
      Number(g.screen?.height) || Infinity,
    );
    const memory = Number(g.navigator?.deviceMemory);
    return (coarse && shortSide < 900) || (memory > 0 && memory <= 4);
  } catch {
    return false;
  }
}

/** MSAA sample count for the Cesium viewer. */
export const viewerMsaaSamples = (g) => (isConstrainedDevice(g) ? 1 : 4);

/** Google 3D tileset cache/detail options for this device. */
export function photorealisticTileOptions(g) {
  return isConstrainedDevice(g)
    ? {
        cacheBytes: 384 * 1024 * 1024,
        maximumCacheOverflowBytes: 256 * 1024 * 1024,
        maximumScreenSpaceError: 24,
      }
    : {
        cacheBytes: 1536 * 1024 * 1024,
        maximumCacheOverflowBytes: 1024 * 1024 * 1024,
      };
}
