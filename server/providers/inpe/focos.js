import {
  INPE_SATELLITES_IN_FIRMS,
  inpeDailyFileName,
  parseInpeFocosCsv,
} from '../../../src/data/inpeFocos.js';

export const INPE_FOCOS_BASE_URL =
  'https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/';

/** Whether INPE fire foci are enabled (`INPE_FOCOS=1`). */
export function inpeFocosEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.INPE_FOCOS || '').trim());
}

/**
 * Fetch today's and yesterday's INPE daily files (UTC) and return
 * FIRMS-shaped records. When `withFirms` is true, satellites already covered
 * by NASA FIRMS are skipped to avoid drawing the same fire twice.
 * A missing file (e.g. today's before INPE publishes it) is not an error.
 * @returns {Promise<{records: object[], files: Array<{file: string, ok: boolean, count: number}>}>}
 */
export async function fetchInpeFocos({
  now = Date.now(),
  withFirms = false,
  fetchImpl = globalThis.fetch,
  baseUrl = INPE_FOCOS_BASE_URL,
} = {}) {
  const skipSatellites = withFirms ? INPE_SATELLITES_IN_FIRMS : undefined;
  const files = [now - 86_400_000, now].map(inpeDailyFileName);
  const records = [];
  const status = [];
  for (const file of files) {
    try {
      const res = await fetchImpl(baseUrl + file, {
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 404) {
        status.push({ file, ok: true, count: 0 });
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseInpeFocosCsv(await res.text(), { skipSatellites });
      if (parsed === null) throw new Error('non-CSV upstream response');
      for (const record of parsed) records.push(record);
      status.push({ file, ok: true, count: parsed.length });
    } catch (err) {
      console.warn(`[inpe-focos] ${file} failed:`, err?.message || err);
      status.push({ file, ok: false, count: 0 });
    }
  }
  if (!status.some((s) => s.ok)) throw new Error('all INPE files failed');
  return { records, files: status };
}
