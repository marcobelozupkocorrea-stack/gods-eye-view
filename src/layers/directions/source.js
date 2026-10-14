/** Build the existing route-proxy query from geographic endpoints.
 * barreto.top: `lang: 'pt'` asks for Portuguese instructions and
 * `avoidTolls` for a toll-free car route; both are omitted when unset, so the
 * URL is unchanged for every other caller. */
export function directionsRequestUrl(
  mode,
  a,
  b,
  { lang, avoidTolls, stops = [], depart } = {},
) {
  const coords = [a, ...(Array.isArray(stops) ? stops : []), b]
    .map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`)
    .join(';');
  return (
    `/api/route?profile=${encodeURIComponent(mode)}&coords=${encodeURIComponent(coords)}&steps=1` +
    (lang === 'pt' ? '&lang=pt' : '') +
    (avoidTolls && mode === 'car' ? '&avoid=tolls' : '') +
    (depart && mode === 'car' ? `&depart=${encodeURIComponent(depart)}` : '')
  );
}

/** Acquire route records using caller-owned transport and an optional endpoint. */
export function createDirectionsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = '/api/route',
} = {}) {
  return {
    async getRoute(
      { mode, a, b, lang, avoidTolls, stops, depart },
      { signal } = {},
    ) {
      signal?.throwIfAborted();
      const query = directionsRequestUrl(mode, a, b, {
        lang,
        avoidTolls,
        stops,
        depart,
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
