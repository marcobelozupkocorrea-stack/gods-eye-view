/**
 * barreto.top: Brazilian public traffic cameras for the CCTV layer.
 *
 * - DER-SP (Departamento de Estradas de Rodagem de São Paulo): the "Câmeras
 *   Online" page publishes its camera list as JSON (coordinates, highway, km,
 *   direction) and live HLS video per camera. The server is plain HTTP on a
 *   fixed address, so the browser only ever sees it through this proxy.
 * - CET-SP (Companhia de Engenharia de Tráfego): the public camera page embeds
 *   its list (folder id + intersection names) in the HTML and serves JPEG
 *   frames. It carries no coordinates, so each intersection is placed from
 *   the table below (street centrelines from OpenStreetMap); cameras CET adds
 *   later stay hidden until they get a position here.
 *
 * Both hosts only answer requests from Brazilian addresses, which is fine for
 * the server-side proxy on the VPS.
 */
import { fallbackHeadingFromId, toFiniteNumber } from './normalize.js';
import { readResponseTextCapped } from '../common/http.js';

export const DERSP_ORIGIN = 'http://200.144.30.103:8084';
export const DERSP_CAMERAS_URL = `${DERSP_ORIGIN}/api/cameras`;
export const DERSP_STREAM_URL = (id) =>
  `${DERSP_ORIGIN}/hls/cam_${encodeURIComponent(id)}/stream.m3u8`;

export const CETSP_ORIGIN = 'https://cameras.cetsp.com.br';
export const CETSP_LIST_URL = `${CETSP_ORIGIN}/View/Cam.aspx`;
export const CETSP_FRAME_URL = (folder) =>
  `${CETSP_ORIGIN}/Cams/${encodeURIComponent(folder)}/1.jpg`;

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 2 * 1024 * 1024;

/** São Paulo state, with a margin: a bad upstream coordinate stays out. */
const inSaoPauloState = (lat, lon) =>
  lat > -25.6 && lat < -19.5 && lon > -53.3 && lon < -44.0;

/**
 * CET-SP camera folder → intersection position. Points are where the two
 * named streets meet in OpenStreetMap (Nominatim centrelines, Oct/2026);
 * 224 is the nearest point of Av. Ibirapuera to R. Ipê.
 */
export const CETSP_POSITIONS = Object.freeze({
  22: { lat: -23.558175, lon: -46.660259 }, // Av Paulista × R Augusta
  23: { lat: -23.567716, lon: -46.649056 }, // Av Paulista × Av Brig Luís Antônio
  180: { lat: -23.547894, lon: -46.649171 }, // R da Consolação × R Caio Prado
  184: { lat: -23.579303, lon: -46.66212 }, // Av Brasil × Av Brig Luís Antônio
  195: { lat: -23.564382, lon: -46.677979 }, // Av Brasil × Av Rebouças
  200: { lat: -23.583446, lon: -46.683231 }, // R Iguatemi × Av Brig Faria Lima
  210: { lat: -23.568646, lon: -46.649885 }, // Av Brig Luís Antônio × Al Santos
  220: { lat: -23.580231, lon: -46.683361 }, // Av Cidade Jardim × Av Nove de Julho
  222: { lat: -23.59739, lon: -46.667895 }, // Av Hélio Pellegrino × R Diogo Jácome
  224: { lat: -23.590405, lon: -46.649836 }, // Av Ibirapuera (R Ipê)
  225: { lat: -23.597752, lon: -46.650579 }, // Av Ascendino Reis × R Pedro de Toledo
});

/** "SÃO SEBASTIÃO" → "São Sebastião" (Portuguese particles stay lower case). */
export function titleCasePlace(value) {
  const small = new Set(['da', 'das', 'de', 'do', 'dos', 'e']);
  return String(value || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) =>
      i > 0 && small.has(word)
        ? word
        : word.replace(
            /^(d')?(\p{L})/u,
            (m, pre = '', ch) => pre + ch.toUpperCase(),
          ),
    )
    .join(' ');
}

const slug = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** "KM 095+000" → "km 95"; "KM 026+500" → "km 26,5". */
export function formatKm(value) {
  const m = /(\d+)\s*\+\s*(\d+)/.exec(String(value || ''));
  if (!m) return String(value || '').trim();
  const km = Number(m[1]);
  const metres = Number(m[2]);
  return metres
    ? `km ${km},${String(metres).padStart(3, '0').replace(/0+$/, '')}`
    : `km ${km}`;
}

/** Shared pose prior for cameras whose direction of view is unknown. */
const unknownPose = (id) => ({
  headingDeg: fallbackHeadingFromId(id),
  headingConfidence: 'low',
  pitchDeg: -18,
  fovDeg: 44,
  rangeM: 145,
  mountHeightM: 8,
});

/** DER-SP `/api/cameras` rows → catalog sources (working cameras only). */
export function parseDerSpCameras(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const id = String(row?.id ?? '').trim();
    if (!/^\d{1,6}$/.test(id)) continue;
    // 1 = no ar; 2 = em manutenção (the page itself shows no video then).
    if (Number(row?.status) !== 1) continue;
    const lat = toFiniteNumber(row?.lat);
    const lon = toFiniteNumber(row?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!inSaoPauloState(lat, lon)) continue;
    const road = String(row?.rodovia || '').trim();
    const km = formatKm(row?.km);
    const roadName = String(row?.nome || '').trim();
    const city = titleCasePlace(row?.local) || 'São Paulo';
    const towards = titleCasePlace(row?.sentido);
    const cameraId = `dersp-${id}`;
    const name = [
      [road, km].filter(Boolean).join(' '),
      roadName,
      towards && towards !== 'Ambos' ? `sentido ${towards}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    out.push({
      id: cameraId,
      name: name || `DER-SP ${id}`,
      city,
      cityId: `dersp-${slug(city) || 'sp'}`,
      provider: 'DER-SP',
      lat,
      lon,
      ...unknownPose(cameraId),
      groundElevationM: 600,
      feedType: 'hls',
      url: DERSP_STREAM_URL(id),
      snapshotUrl: '',
      sourceKind: 'dersp-cameras-online',
      license: 'Câmera pública do DER-SP (Câmeras Online)',
      credit: 'DER-SP',
      code: [road, km].filter(Boolean).join(' '),
    });
  }
  return out;
}

const unquote = (value) =>
  String(value ?? '')
    .replace(/^'|'$/g, '')
    .replace(/\\'/g, "'")
    .trim();

/** The `gCams.push({...})` entries of CET's camera page. */
export function parseCetSpCamList(html) {
  const out = [];
  const text = String(html || '');
  for (const m of text.matchAll(/gCams\.push\(\{([^}]*)\}\)/g)) {
    const fields = {};
    for (const f of m[1].matchAll(/(\w+)\s*:\s*('(?:[^'\\]|\\.)*'|[^,]+)/g)) {
      fields[f[1]] = unquote(f[2]);
    }
    out.push({
      folder: String(fields.pasta || '').trim(),
      title: fields.titulo || '',
      cross: fields.subTitulo || '',
      detail: fields.detalhe || '',
      active: fields.ativa === 'true',
    });
  }
  return out;
}

/** CET list entries → catalog sources (active and positioned only). */
export function cetSpSources(entries, positions = CETSP_POSITIONS) {
  const out = [];
  for (const entry of entries) {
    if (!entry.active || !/^\d{1,4}$/.test(entry.folder)) continue;
    const at = positions[entry.folder];
    if (!at) continue;
    const cameraId = `cetsp-${entry.folder}`;
    const name =
      [entry.title, entry.cross].filter(Boolean).join(' × ') +
      (entry.detail ? ` (${entry.detail})` : '');
    out.push({
      id: cameraId,
      name: name || `CET ${entry.folder}`,
      city: 'São Paulo',
      cityId: 'cetsp-sao-paulo',
      provider: 'CET-SP',
      lat: at.lat,
      lon: at.lon,
      ...unknownPose(cameraId),
      groundElevationM: 760,
      feedType: 'image',
      url: CETSP_FRAME_URL(entry.folder),
      snapshotUrl: CETSP_FRAME_URL(entry.folder),
      sourceKind: 'cetsp-cameras',
      license: 'Câmera pública da CET-SP',
      credit: 'CET-SP',
      code: `CET ${entry.folder}`,
    });
  }
  return out;
}

async function fetchText(url, fetchImpl) {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const resp = await fetchImpl(url, {
    signal,
    redirect: 'error',
    headers: { Accept: 'application/json, text/html;q=0.9, */*;q=0.5' },
  });
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${resp.status}`);
  }
  return readResponseTextCapped(resp, MAX_BYTES, signal);
}

/** Live pack loader: DER-SP highway cameras with live video. */
export async function loadDerSpSources({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  if (String(process.env.CCTV_DERSP_ENABLED || '1').trim() === '0') return [];
  try {
    const rows = JSON.parse(await fetchText(DERSP_CAMERAS_URL, fetchImpl));
    const cameras = parseDerSpCameras(rows);
    console.log(`[CCTV] Loaded DER-SP camera sources: ${cameras.length}`);
    return cameras;
  } catch (error) {
    console.warn('[CCTV] DER-SP camera list error:', error?.message || error);
    return [];
  }
}

/** Live pack loader: CET-SP city intersection cameras (JPEG frames). */
export async function loadCetSpSources({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  if (String(process.env.CCTV_CETSP_ENABLED || '1').trim() === '0') return [];
  try {
    const entries = parseCetSpCamList(
      await fetchText(CETSP_LIST_URL, fetchImpl),
    );
    const cameras = cetSpSources(entries);
    const unplaced = entries.filter(
      (e) => e.active && !CETSP_POSITIONS[e.folder],
    ).length;
    console.log(
      `[CCTV] Loaded CET-SP camera sources: ${cameras.length}` +
        (unplaced ? ` (${unplaced} sem posição conhecida)` : ''),
    );
    return cameras;
  } catch (error) {
    console.warn('[CCTV] CET-SP camera list error:', error?.message || error);
    return [];
  }
}
