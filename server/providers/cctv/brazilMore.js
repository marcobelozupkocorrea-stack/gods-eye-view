/**
 * barreto.top: more Brazilian public cameras for the CCTV layer (all JPEG
 * frames, all with coordinates, no login). Checked October 2026.
 *
 * - Recife (CTTU, via Serttel): ~120 city intersection cameras. The list is a
 *   JS array in the public page; frames come from a snapshot handler behind
 *   Cloudflare (bursts get HTTP 429, so frames are fetched on demand only).
 * - Praia Grande (SP): ~67 seafront and street cameras. JSON list; frames
 *   need a form POST (see media.js CCTV_IMAGE_POST_HOSTS).
 * - Itanhaém (SP): ~10 cameras listed in the page; plain JPEG frames.
 * - DAER-RS (Rio Grande do Sul state roads): the cameras with a position;
 *   each frame URL is read once from the camera's page fragment.
 */
import { fallbackHeadingFromId } from './normalize.js';
import { readResponseTextCapped } from '../common/http.js';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 3 * 1024 * 1024;

export const RECIFE_PAGE_URL = 'https://transito-recife.serttel.com.br/';
export const RECIFE_FRAME_URL = (id) =>
  `https://transito-recife.serttel.com.br/Index?handler=Snapshot&Codigo=${encodeURIComponent(id)}`;
export const PRAIA_GRANDE_LIST_URL =
  'https://cameras.praiagrande.sp.gov.br/aovivo/api';
export const PRAIA_GRANDE_FRAME_URL = (name, server) =>
  `https://cameras.praiagrande.sp.gov.br/aovivo/get-snapshot/slideshow/${encodeURIComponent(name)}?Server=${encodeURIComponent(server)}`;
export const ITANHAEM_PAGE_URL = 'https://www.itanhaem.sp.gov.br/aovivo/';
export const DAER_LIST_URL =
  'https://www.daer.rs.gov.br/cameras-de-monitoramento/listfilho?carregarlocaisrelacionados=true';
export const DAER_FRAGMENT_URL = (slug) =>
  `https://www.daer.rs.gov.br/_service/mapacameras?urlamigavel=${encodeURIComponent(slug)}&alttemplate=pagina.listalocal.mapacameras.conteudolocal`;

const inBrazil = (lat, lon) =>
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  lat > -34 &&
  lat < 5.5 &&
  lon > -74 &&
  lon < -28.5;

/** Same pose prior as brazil.js: direction of view unknown. */
const pose = (id) => ({
  headingDeg: fallbackHeadingFromId(id),
  headingConfidence: 'low',
  pitchDeg: -18,
  fovDeg: 44,
  rangeM: 145,
  mountHeightM: 8,
});

/** "AV. MARCOS FREIRE 02 - Lateral" → "Av. Marcos Freire 02 - Lateral". */
export function tidyName(value) {
  const small = new Set(['da', 'das', 'de', 'do', 'dos', 'e', 'x']);
  return String(value || '')
    .replace(/\s*\((internet|briefcam)\)\s*/gi, ' ')
    .replace(/[#_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .map((w, i) =>
      i > 0 && small.has(w)
        ? w
        : w.replace(/^(\p{L})/u, (c) => c.toUpperCase()),
    )
    .join(' ')
    .replace(/\b(Ers|Br|Rsc|Sp|Km)\b/g, (m) => m.toUpperCase());
}

const slug = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function camera({ id, name, city, provider, lat, lon, url, elevation, code }) {
  return {
    id,
    name,
    city,
    cityId: `${slug(provider)}-${slug(city)}`,
    provider,
    lat,
    lon,
    ...pose(id),
    groundElevationM: elevation,
    feedType: 'image',
    url,
    snapshotUrl: url,
    sourceKind: `${slug(provider)}-cameras`,
    license: `Câmera pública (${provider})`,
    credit: provider,
    code: code || '',
  };
}

/** The `let cameras = [...]` array of the Recife page. */
export function parseRecife(html) {
  const m = String(html || '').match(/let\s+cameras\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return [];
  let rows;
  try {
    rows = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const out = [];
  for (const r of rows) {
    const lat = Number(r?.LatLng?.lat);
    const lon = Number(r?.LatLng?.lng);
    const idNum = Number(r?.IdCamera);
    if (!Number.isInteger(idNum) || !inBrazil(lat, lon)) continue;
    out.push(
      camera({
        id: `recife-${idNum}`,
        name:
          String(r.Endereco || '')
            .replace(/\s*-\s*Sem\.\s*\d+\s*$/i, '')
            .trim() || `CTTU ${r.Codigo || idNum}`,
        city: 'Recife',
        provider: 'CTTU Recife',
        lat,
        lon,
        url: RECIFE_FRAME_URL(idNum),
        elevation: 5,
        code: String(r.Codigo || ''),
      }),
    );
  }
  return out;
}

export function parsePraiaGrande(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const lat = Number(r?.Latitude);
    const lon = Number(r?.Longitude);
    const name = String(r?.Name || '').trim();
    const server = String(r?.Server || '').trim();
    if (!name || !/^server-\d{1,3}$/.test(server) || !inBrazil(lat, lon))
      continue;
    out.push(
      camera({
        id: `praiagrande-${String(r.Id || name).slice(0, 40)}`,
        name: tidyName(r.Description || name),
        city: 'Praia Grande',
        provider: 'Prefeitura de Praia Grande',
        lat,
        lon,
        url: PRAIA_GRANDE_FRAME_URL(name, server),
        elevation: 5,
      }),
    );
  }
  return out;
}

/** `const cameras = [{ id: '…', label: '…', lat, lng, url: '…' }]` (JS). */
export function parseItanhaem(html) {
  const text = String(html || '');
  const start = text.search(/cameras\s*=\s*\[/);
  if (start < 0) return [];
  const block = text.slice(start, text.indexOf('];', start) + 1);
  const out = [];
  for (const m of block.matchAll(/\{([^{}]*)\}/g)) {
    const field = (k) =>
      m[1].match(
        new RegExp(`${k}\\s*:\\s*(?:'([^']*)'|"([^"]*)"|(-?[\\d.]+))`),
      );
    const get = (k) => {
      const f = field(k);
      return f ? (f[1] ?? f[2] ?? f[3]) : null;
    };
    const id = get('id');
    const lat = Number(get('lat'));
    const lon = Number(get('lng'));
    const url = get('url');
    if (
      !id ||
      !/^[\w-]{1,40}$/.test(id) ||
      !inBrazil(lat, lon) ||
      !/^https:\/\/www\.itanhaem\.sp\.gov\.br\/aovivo\/cameras\/[\w-]+\.jpg$/.test(
        url || '',
      )
    )
      continue;
    out.push(
      camera({
        id: `itanhaem-${id}`,
        name: tidyName(get('label') || id),
        city: 'Itanhaém',
        provider: 'Prefeitura de Itanhaém',
        lat,
        lon,
        url,
        elevation: 5,
      }),
    );
  }
  return out;
}

/** DAER list → {slug, title, lat, lon} for cameras with a position. */
export function parseDaerList(body) {
  const items = body?.itens && typeof body.itens === 'object' ? body.itens : {};
  const out = [];
  for (const item of Object.values(items)) {
    if (!item?.ativo || !item.urlamigavel) continue;
    const pts = JSON.stringify(item).match(
      /"pontos":\s*"\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)"/,
    );
    if (!pts) continue;
    const lat = Number(pts[1]);
    const lon = Number(pts[2]);
    if (!inBrazil(lat, lon)) continue;
    out.push({
      slug: String(item.urlamigavel),
      title: String(item.titulo || '')
        .replace(/\s+/g, ' ')
        .trim(),
      lat,
      lon,
    });
  }
  return out;
}

/** The frame link of one DAER camera fragment (https on port 443 only). */
export function parseDaerFrame(html) {
  const m = String(html || '').match(
    /class="cameraRodoviaLightBox"[^>]*?href="([^"]+)"/,
  );
  const href = m?.[1]?.trim();
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === 'https:' && !u.port ? u.href : null;
  } catch {
    return null;
  }
}

async function fetchText(url, fetchImpl, accept = 'text/html, */*;q=0.5') {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const resp = await fetchImpl(url, {
    signal,
    headers: { Accept: accept, 'User-Agent': 'barreto.top/1.0 (cameras)' },
  });
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${resp.status}`);
  }
  return readResponseTextCapped(resp, MAX_BYTES, signal);
}

const enabled = (name) => String(process.env[name] || '1').trim() !== '0';

async function guarded(label, work) {
  try {
    const cams = await work();
    console.log(`[CCTV] Loaded ${label} camera sources: ${cams.length}`);
    return cams;
  } catch (error) {
    console.warn(`[CCTV] ${label} camera list error:`, error?.message || error);
    return [];
  }
}

export const loadRecifeSources = ({ fetchImpl = globalThis.fetch } = {}) =>
  enabled('CCTV_RECIFE_ENABLED')
    ? guarded('Recife', async () =>
        parseRecife(await fetchText(RECIFE_PAGE_URL, fetchImpl)),
      )
    : Promise.resolve([]);

export const loadPraiaGrandeSources = ({
  fetchImpl = globalThis.fetch,
} = {}) =>
  enabled('CCTV_PRAIAGRANDE_ENABLED')
    ? guarded('Praia Grande', async () =>
        parsePraiaGrande(
          JSON.parse(
            await fetchText(
              PRAIA_GRANDE_LIST_URL,
              fetchImpl,
              'application/json',
            ),
          ),
        ),
      )
    : Promise.resolve([]);

export const loadItanhaemSources = ({ fetchImpl = globalThis.fetch } = {}) =>
  enabled('CCTV_ITANHAEM_ENABLED')
    ? guarded('Itanhaém', async () =>
        parseItanhaem(await fetchText(ITANHAEM_PAGE_URL, fetchImpl)),
      )
    : Promise.resolve([]);

/** Frame links change rarely: keep them for the life of the process. */
const daerFrames = new Map();
export const loadDaerRsSources = ({ fetchImpl = globalThis.fetch } = {}) =>
  enabled('CCTV_DAERRS_ENABLED')
    ? guarded('DAER-RS', async () => {
        const list = parseDaerList(
          JSON.parse(
            await fetchText(DAER_LIST_URL, fetchImpl, 'application/json'),
          ),
        );
        const out = [];
        for (const cam of list) {
          let frame = daerFrames.get(cam.slug);
          if (frame === undefined) {
            frame = await fetchText(DAER_FRAGMENT_URL(cam.slug), fetchImpl)
              .then(parseDaerFrame)
              .catch(() => null);
            daerFrames.set(cam.slug, frame);
          }
          if (!frame) continue;
          out.push(
            camera({
              id: `daerrs-${cam.slug.slice(0, 50)}`,
              name: cam.title,
              city: 'Rio Grande do Sul',
              provider: 'DAER-RS',
              lat: cam.lat,
              lon: cam.lon,
              url: frame,
              elevation: 100,
              code: cam.title.split(' ').slice(0, 2).join(' '),
            }),
          );
        }
        return out;
      })
    : Promise.resolve([]);
