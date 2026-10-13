import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Request active INMET warnings through the same-origin proxy. */
export function createInmetAlertSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/inmet/alerts', { signal });
      if (!response.ok) throw new Error(`INMET HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        64 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.rows))
        throw new Error('Malformed INMET snapshot');
      return payload.rows;
    },
  };
}
