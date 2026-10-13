import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Request active INMET warnings through the same-origin proxy. */
export function createInmetAlertSource(options = {}) {
  return createAlertSource({ endpoint: '/api/inmet/alerts', ...options });
}

/** Request active Defesa Civil (IDAP) alerts through the same-origin proxy. */
export function createDefesaCivilAlertSource(options = {}) {
  return createAlertSource({
    endpoint: '/api/defesacivil/alerts',
    ...options,
  });
}

/** Snapshot source for a same-origin CAP alert proxy. */
export function createAlertSource({
  endpoint,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(endpoint, { signal });
      if (!response.ok) throw new Error(`Alerts HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        64 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.rows))
        throw new Error('Malformed alert snapshot');
      return payload.rows;
    },
  };
}
