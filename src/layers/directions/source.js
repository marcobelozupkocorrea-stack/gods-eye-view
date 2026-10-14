/** Build the existing route-proxy query from geographic endpoints.
 * barreto.top: `lang: 'pt'` asks for Portuguese instructions and
 * `avoidTolls` for a toll-free car route; both are omitted when unset, so the
 * URL is unchanged for every other caller. */
export function directionsRequestUrl(mode, a, b, { lang, avoidTolls } = {}) {
  const coords = `${a.lon.toFixed(6)},${a.lat.toFixed(6)};${b.lon.toFixed(6)},${b.lat.toFixed(6)}`;
  return (
    `/api/route?profile=${encodeURIComponent(mode)}&coords=${encodeURIComponent(coords)}&steps=1` +
    (lang === 'pt' ? '&lang=pt' : '') +
    (avoidTolls && mode === 'car' ? '&avoid=tolls' : '')
  );
}

/** Acquire route records using caller-owned transport and an optional endpoint. */
export function createDirectionsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = '/api/route',
} = {}) {
  return {
    async getRoute({ mode, a, b, lang, avoidTolls }, { signal } = {}) {
      signal?.throwIfAborted();
      const query = directionsRequestUrl(mode, a, b, {
        lang,
        avoidTolls,
      }).split('?')[1];
      const response = await fetchImpl(`${endpoint}?${query}`, {
        signal,
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json();
      signal?.throwIfAborted();
      if (response.status === 429) {
        throw new Error(
          typeof payload?.error === 'string' && payload.error
            ? `${payload.error} — try again in a moment`
            : 'Routing is rate limited — try again in a moment',
        );
      }
      if (!response.ok && !payload?.error)
        throw new Error(`Routing unavailable (HTTP ${response.status})`);
      return payload;
    },
  };
}
