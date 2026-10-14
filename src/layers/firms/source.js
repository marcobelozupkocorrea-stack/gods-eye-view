export const SOUTH_AMERICA_BBOX = '-92,-57,-26,15';

/** barreto.top: area the fire feed is cut to (set once at startup). */
let firmsRegion = null;
export function setFirmsRegion(bbox) {
  firmsRegion = /^-?[\d.]+(,-?[\d.]+){3}$/.test(String(bbox || ''))
    ? String(bbox)
    : null;
}

/** Construct the existing live-fire endpoint without making a request. */
export function createFirmsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      // barreto.top (pt-BR): South America only, revalidated with ETag.
      const region = firmsRegion;
      const response = await fetchImpl(
        region ? `/api/firms?bbox=${region}` : '/api/firms',
        { signal, cache: region ? 'no-cache' : 'no-store' },
      );
      let payload;
      try {
        payload = await response.json();
      } catch {
        /* status below remains authoritative */
      }
      signal?.throwIfAborted();
      if (!response.ok) {
        if (response.status === 503 && payload?.error === 'no_key')
          return { keyRequired: true };
        throw new Error(`FIRMS HTTP ${response.status}`);
      }
      if (!Array.isArray(payload?.fires))
        throw new Error('Malformed fire snapshot');
      return payload;
    },
  };
}
