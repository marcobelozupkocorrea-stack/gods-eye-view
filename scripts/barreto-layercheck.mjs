#!/usr/bin/env node
/**
 * barreto.top layer check: asks the running server (and, for layers the
 * browser loads straight from the source, that source) for the same data
 * each layer in CAMADAS uses, and prints one line per layer:
 *   OK        works, with data over Brazil
 *   LIMITADO  works, but only outside Brazil, in reduced mode or on demand
 *   SEM CHAVE needs an API key that is not configured
 *   FALHA     broken right now
 * Runs in the selfcheck container next to the server; exits non-zero only
 * on FALHA. Usage: node scripts/barreto-layercheck.mjs [baseUrl]
 */
import http from 'node:http';
import https from 'node:https';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const BASE =
  process.argv[2] || process.env.GEV_LAYERCHECK_BASE || 'http://gev:4173';
const RELEASE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BRAZIL = { west: -74, south: -34, east: -34.5, north: 5.5 };
const inBrazil = (lat, lon) =>
  lat >= BRAZIL.south &&
  lat <= BRAZIL.north &&
  lon >= BRAZIL.west &&
  lon <= BRAZIL.east;

function getOnce(
  url,
  { headers = {}, maxBytes = 64 << 20, timeoutMs = 60_000 } = {},
) {
  const target = new URL(url, BASE);
  const local = target.origin === new URL(BASE).origin;
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: 'GET',
        headers: {
          'user-agent': 'barreto-layercheck/1',
          // The server only answers its own host names; localhost always is one.
          ...(local ? { host: 'localhost' } : {}),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error(`resposta maior que ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () =>
      req.destroy(new Error(`sem resposta em ${timeoutMs / 1000}s`)),
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * GET with a short retry for our own server: after a key change the server
 * rebuilds and swaps releases (~1 s), and a check landing in that gap would
 * otherwise read as a failure.
 */
export async function get(url, options) {
  const local = new URL(url, BASE).origin === new URL(BASE).origin;
  for (let attempt = 0; ; attempt++) {
    try {
      return await getOnce(url, options);
    } catch (err) {
      const transient = /ECONNREFUSED|ECONNRESET|socket hang up/i.test(
        `${err?.code} ${err?.message}`,
      );
      if (!local || !transient || attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

const json = (res) => {
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    return null;
  }
};

/** Length of the first array found at the top level (or the value itself). */
export function countOf(value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return null;
  for (const key of [
    'rows',
    'features',
    'states',
    'aircraft',
    'ac',
    'vessels',
    'results',
    'launches',
    'stations',
    'storms',
    'feeds',
    'vehicles',
    'sources',
    'items',
  ]) {
    if (Array.isArray(value[key])) return value[key].length;
    if (Array.isArray(value?.data?.[key])) return value.data[key].length;
  }
  const first = Object.values(value).find(Array.isArray);
  return first ? first.length : null;
}

/** Share of non-transparent pixels in an 8-bit RGBA / RGB / palette PNG. */
export function pngCoverage(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const kind = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      if (data[12]) return null; // interlaced
    } else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || ![2, 3, 6].includes(type)) return null;
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const prev = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  let painted = 0;
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i];
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = x;
      if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      line[i] = v & 255;
    }
    for (let px = 0; px < width; px++) {
      if (type === 6) {
        if (line[px * 4 + 3] > 16) painted++;
      } else if (type === 3) {
        const alpha = trns && line[px] < trns.length ? trns[line[px]] : 255;
        if (alpha > 16) painted++;
      } else painted++;
    }
    line.copy(prev);
  }
  return width * height ? painted / (width * height) : 0;
}

const pct = (v) => `${(v * 100).toFixed(v < 0.01 && v > 0 ? 2 : 0)}%`;

const STEP = 0.25;
const snap = (n) => Math.round(n / STEP) * STEP + 0;

/**
 * The weather proxy only renders 2:1 (lon:lat) windows on a 0.25° grid, so
 * take the tallest such window over Brazil that fits the product's extent.
 */
export function brazilWindow(bounds) {
  const south = Math.max(BRAZIL.south, bounds.south);
  const north = Math.min(BRAZIL.north, bounds.north);
  const west = Math.max(BRAZIL.west - 20, bounds.west);
  const east = Math.min(BRAZIL.east + 20, bounds.east);
  if (south >= north - 1 || west >= east - 2) return null;
  if (bounds.east < BRAZIL.west || bounds.west > BRAZIL.east) return null;
  let height = Math.min(north - south, (east - west) / 2);
  height = Math.floor(height / STEP) * STEP;
  if (height < 1) return null;
  const midLat = (south + north) / 2;
  const midLon = Math.min(Math.max(-54, west + height), east - height);
  const box = [
    snap(midLon - height),
    snap(midLat - height / 2),
    snap(midLon + height),
    snap(midLat + height / 2),
  ];
  if (box[0] < bounds.west) ((box[0] += STEP), (box[2] += STEP));
  if (box[2] > bounds.east) ((box[0] -= STEP), (box[2] -= STEP));
  if (box[1] < bounds.south) ((box[1] += STEP), (box[3] += STEP));
  if (box[3] > bounds.north) ((box[1] -= STEP), (box[3] -= STEP));
  return box;
}

function weatherCheck(product, label) {
  return async () => {
    const manifest = json(
      await get(`/api/weather/manifest?product=${product}`),
    );
    const latest = manifest?.latest;
    const b = manifest?.bounds;
    const bounds = b;
    if (!latest || !b)
      return [
        'FALHA',
        `sem imagem recente (${JSON.stringify(manifest)?.slice(0, 120)})`,
      ];
    const box = brazilWindow(b);
    const age = Math.round((Date.now() - Date.parse(latest)) / 60_000);
    const extent = `cobre lat ${b.south.toFixed(0)}…${b.north.toFixed(0)}, lon ${b.west.toFixed(0)}…${b.east.toFixed(0)}`;
    if (!box)
      return [
        'LIMITADO',
        `${label}: funciona, mas não cobre o Brasil (${extent}); última imagem há ${age} min`,
      ];
    const image = await get(
      `/api/weather/image?product=${product}&time=${encodeURIComponent(latest)}&bbox=${box.join(',')}`,
    );
    if (image.status !== 200)
      return [
        'FALHA',
        `imagem HTTP ${image.status} ${image.body.toString('utf8').slice(0, 120)}`,
      ];
    const coverage = pngCoverage(image.body);
    // Partial means the product itself stops short of Brazil, not that the
    // 2:1 test window does.
    const partial =
      b.south > BRAZIL.south + 1 ||
      b.north < BRAZIL.north - 1 ||
      b.west > BRAZIL.west + 1 ||
      b.east < BRAZIL.east - 1;
    const detail = `${label}: imagem de há ${age} min sobre o Brasil, ${coverage == null ? `${Math.round(image.body.length / 1024)} KB` : `${pct(coverage)} da área com dados`}; ${extent}`;
    return [
      partial ? 'LIMITADO' : 'OK',
      detail + (partial ? ' (só parte do Brasil)' : ''),
    ];
  };
}

function bundled(prefix, label, countBrazil) {
  return async () => {
    const dir = path.join(RELEASE_DIR, 'dist', 'assets');
    const file = readdirSync(dir).find((f) => f.startsWith(`${prefix}-`));
    if (!file) return ['FALHA', `arquivo ${prefix} não está no build`];
    const res = await get(`/assets/${file}`);
    if (res.status !== 200)
      return ['FALHA', `/assets/${file} HTTP ${res.status}`];
    const [total, br] = countBrazil(readFileSync(path.join(dir, file), 'utf8'));
    return [
      'OK',
      `${label}: ${total} itens no mundo, ${br} no Brasil (dados fixos do build)`,
    ];
  };
}

function geojsonlCount(text) {
  let total = 0;
  let br = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    total++;
    try {
      const f = JSON.parse(line);
      const c = f.geometry?.coordinates;
      const pt =
        f.geometry?.type === 'Point'
          ? c
          : Array.isArray(c?.[0]?.[0])
            ? c[0][0]
            : c?.[0];
      if (pt && inBrazil(pt[1], pt[0])) br++;
    } catch {
      /* skip */
    }
  }
  return [total, br];
}

const LAYERS = [
  [
    'Satélites',
    async () => {
      const res = await get('/api/celestrak/stations');
      const n = res.body
        .toString('utf8')
        .split('\n')
        .filter((l) => l.startsWith('1 ')).length;
      return res.status === 200 && n
        ? ['OK', `${n} satélites no grupo estações (CelesTrak)`]
        : ['FALHA', `HTTP ${res.status}`];
    },
  ],
  [
    'Voos ao vivo',
    async () => {
      const res = await get('/api/flights?lat=-23.5505&lon=-46.6333');
      const n = countOf(json(res));
      if (res.status !== 200 || !n)
        return ['FALHA', `HTTP ${res.status}, ${n ?? 0} aviões`];
      return [
        'OK',
        `${n} aviões · fonte ${res.headers['x-flight-source'] || 'OpenSky'}`,
      ];
    },
  ],
  [
    'Voos militares',
    async () => {
      const res = await get('/api/military');
      const n = countOf(json(res));
      return res.status === 200 && n
        ? ['OK', `${n} aeronaves militares no mundo (adsb.lol)`]
        : ['FALHA', `HTTP ${res.status}`];
    },
  ],
  [
    'ADS-B local',
    async () => [
      'LIMITADO',
      'precisa de um receptor RTL-SDR ligado na USB do computador (Chrome); sem ele não mostra nada',
    ],
  ],
  [
    'Navios ao vivo',
    async () => {
      const all = await get('/api/vessels?maxRows=12000');
      const n = countOf(json(all));
      if (all.status === 503) return ['SEM CHAVE', 'AISSTREAM_API_KEY ausente'];
      if (all.status !== 200 || !n) return ['FALHA', `HTTP ${all.status}`];
      return [
        'OK',
        `${n} navios recebidos desde que o servidor ligou (o número cresce com o tempo)`,
      ];
    },
  ],
  [
    'Trânsito',
    async () => {
      const status = json(await get('/api/tomtom/status'));
      const roads = await get('https://tiles.openfreemap.org/planet');
      if (roads.status !== 200)
        return ['FALHA', `mapa de vias HTTP ${roads.status}`];
      if (status?.hasKey) {
        // One real flow tile over São Paulo proves the key works.
        const tile = await get('/api/tomtom/flow/10/379/580.pbf');
        return tile.status === 200
          ? [
              'OK',
              `vias + fluxo ao vivo TomTom (${status.dailyCount ?? '?'} de ${status.budget ?? '?'} pedidos hoje)`,
            ]
          : ['FALHA', `chave TomTom recusada: HTTP ${tile.status}`];
      }
      return [
        'SEM CHAVE',
        'mostra as vias, mas o fluxo é SIMULADO: falta TOMTOM_API_KEY (plano gratuito da TomTom)',
      ];
    },
  ],
  [
    'Transporte público',
    async () => {
      const feeds = json(await get('/api/transit/feeds'));
      const n = countOf(feeds);
      const v = await get('/api/transit/vehicles/mbta');
      const vn = countOf(json(v));
      if (!n) return ['FALHA', 'lista de cidades vazia'];
      return [
        'LIMITADO',
        `${n} cidades (Boston, Austin, Minneapolis, Helsinque, Holanda, Noruega, Queensland), nenhuma no Brasil · Boston agora: ${vn ?? 0} veículos`,
      ];
    },
  ],
  [
    'Bicicletas compartilhadas',
    async () => {
      const url = encodeURIComponent(
        'https://saopaulo.publicbikesystem.net/customer/gbfs/v2/pt/station_status.json',
      );
      const res = await get(`/api/gbfs/${url}`);
      const stations = json(res)?.data?.stations || [];
      const bikes = stations.reduce(
        (sum, s) => sum + (Number(s.num_bikes_available) || 0),
        0,
      );
      return res.status === 200 && stations.length
        ? [
            'OK',
            `Bike Itaú São Paulo: ${stations.length} estações, ${bikes} bicicletas livres agora (também Rio, Recife, Salvador, Porto Alegre, Brasília, Curitiba)`,
          ]
        : ['FALHA', `HTTP ${res.status}`];
    },
  ],
  [
    'Câmeras públicas',
    async () => {
      const res = await get('/api/cctv/sources');
      const list = json(res);
      const cams = Array.isArray(list)
        ? list
        : list?.sources || list?.cameras || [];
      const br = cams.filter((c) =>
        inBrazil(
          Number(c.lat ?? c.latitude),
          Number(c.lon ?? c.lng ?? c.longitude),
        ),
      ).length;
      return res.status === 200 && cams.length
        ? ['OK', `${cams.length} câmeras, ${br} no Brasil (DER-SP + CET-SP)`]
        : ['FALHA', `HTTP ${res.status}`];
    },
  ],
  [
    'Imagens recentes',
    async () => {
      const since = new Date(Date.now() - 10 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const cmr = await get(
        `https://cmr.earthdata.nasa.gov/search/granules.umm_json?short_name=HLSS30&bounding_box=-47,-24,-46,-23&temporal=${since}T00:00:00Z,&page_size=20`,
      );
      const tile = await get(
        `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA21_CorrectedReflectance_TrueColor/default/${day}/GoogleMapsCompatible_Level9/5/17/11.jpg`,
      );
      const hits = cmr.headers['cmr-hits'] ?? json(cmr)?.hits;
      if (tile.status !== 200 && cmr.status !== 200)
        return ['FALHA', `NASA CMR ${cmr.status}, GIBS ${tile.status}`];
      return [
        'OK',
        `NASA respondendo: ${hits ?? '?'} cenas Sentinel (HLS) de São Paulo nos últimos 10 dias, mosaico VIIRS de ontem ${tile.status === 200 ? 'ok' : `HTTP ${tile.status}`} · abre ao marcar um ponto no mapa`,
      ];
    },
  ],
  [
    'Fotos de rua',
    async () => {
      const res = await get('/api/mapillary/status', {
        headers: {
          origin: 'http://localhost',
          'sec-fetch-site': 'same-origin',
        },
      });
      const s = json(res);
      const ok = s?.configured ?? s?.enabled ?? s?.ok;
      return ok
        ? ['OK', 'Mapillary configurado']
        : [
            'SEM CHAVE',
            'falta MAPILLARY_CLIENT_TOKEN (grátis) ou GOOGLE_MAPS_API_KEY; sem chave não há fotos',
          ];
    },
  ],
  [
    'Câmeras de placas (ALPR)',
    async () => {
      const res = await get(
        'https://tiles.dontgetflocked.com/cameras-us-hourly.json',
      );
      return res.status === 200
        ? ['LIMITADO', 'funciona, mas o mapeamento só existe para EUA e Canadá']
        : ['FALHA', `HTTP ${res.status}`];
    },
  ],
  [
    'Instalações militares',
    async () => {
      const res = await get(
        '/api/military-installations?south=-23.70000&west=-46.80000&north=-23.40000&east=-46.40000',
      );
      const body = json(res);
      if (res.status === 503 || body?.code === 'OVERPASS_NOT_CONFIGURED')
        return [
          'LIMITADO',
          'modo reduzido: sem servidor Overpass configurado, usa o mapa base + nomes embutidos (menos detalhes)',
        ];
      if (res.status === 200)
        return [
          'OK',
          `${countOf(body) ?? 0} instalações em São Paulo (Overpass)`,
        ];
      return ['FALHA', `HTTP ${res.status}`];
    },
  ],
  ['Data centers', bundled('datacenters', 'base OSM', geojsonlCount)],
  [
    'Cabos submarinos',
    bundled('cable-geo', 'TeleGeography', (text) => {
      const f = JSON.parse(text).features || [];
      const br = f.filter((x) =>
        JSON.stringify(x.geometry?.coordinates || []).match(
          /\[-(3[5-9]|4\d|5\d)\.\d+,-?(\d|1\d|2\d|3[0-3])\.\d+\]/,
        ),
      ).length;
      return [f.length, `~${br}`];
    }),
  ],
  ['Barragens', bundled('dams', 'base OSM/OpenInfraMap', geojsonlCount)],
  [
    'Lançamentos espaciais',
    async () => {
      const res = await get('/api/launches');
      const n = countOf(json(res));
      return res.status === 200 && n
        ? ['OK', `${n} lançamentos nos últimos 30 dias`]
        : ['FALHA', `HTTP ${res.status}`];
    },
  ],
  [
    'Terremotos',
    async () => {
      const res = await get(
        'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
      );
      const f = json(res)?.features || [];
      const sa = f.filter((q) => {
        const [lon, lat] = q.geometry?.coordinates || [];
        return lat < 13 && lat > -56 && lon > -82 && lon < -34;
      }).length;
      return res.status === 200
        ? [
            'OK',
            `${f.length} tremores nas últimas 24 h no mundo, ${sa} na América do Sul`,
          ]
        : ['FALHA', `USGS HTTP ${res.status}`];
    },
  ],
  [
    'Perímetros de incêndio (EUA)',
    async () => {
      const res = await get('/api/fire-perimeters');
      const n = countOf(json(res));
      return res.status === 200
        ? [
            'LIMITADO',
            `funciona (${n ?? 0} incêndios ativos), mas só existe para os EUA`,
          ]
        : ['FALHA', `HTTP ${res.status}`];
    },
  ],
  [
    'Vento',
    async () => {
      const manifest = json(await get('/api/wind/manifest?model=gfs'));
      if (!manifest?.gridUrl)
        return [
          'FALHA',
          `manifesto sem grade (${JSON.stringify(manifest)?.slice(0, 120)})`,
        ];
      const grid = await get(manifest.gridUrl, { timeoutMs: 120_000 });
      return grid.status === 200 && grid.body.length
        ? [
            'OK',
            `previsão GFS global, grade de ${Math.round(grid.body.length / 1024)} KB`,
          ]
        : ['FALHA', `grade HTTP ${grid.status}`];
    },
  ],
  ['Radar de chuva (EUA)', weatherCheck('radar', 'radar NOAA')],
  ['Nuvens por satélite', weatherCheck('clouds-br', 'GOES-19 CPTEC/INPE')],
  [
    'Nuvens (GOES América do Norte)',
    weatherCheck('clouds-regional', 'GOES regional'),
  ],
  [
    'Radar de chuva (Brasil)',
    async () => {
      const manifest = json(await get('/api/brazil-radar/manifest'));
      const radars = manifest?.radars;
      if (!Array.isArray(radars))
        return [
          'FALHA',
          `manifesto inválido (${JSON.stringify(manifest)?.slice(0, 120)})`,
        ];
      if (!radars.length)
        return ['LIMITADO', 'nenhum radar transmitindo agora'];
      const first = radars.find((r) => /saoroque/.test(r.id)) || radars[0];
      const frame = await get(
        `/api/brazil-radar/frame?id=${encodeURIComponent(first.id)}&stamp=${first.stamp}`,
      );
      const age = Math.round((Date.now() - Date.parse(first.time)) / 60_000);
      return frame.status === 200
        ? [
            'OK',
            `${radars.length} radares ao vivo (${radars
              .slice(0, 6)
              .map((r) => r.name)
              .join(', ')}…); ${first.name}: imagem de há ${age} min`,
          ]
        : ['FALHA', `imagem HTTP ${frame.status}`];
    },
  ],
  ['Nuvens (mosaico global)', weatherCheck('clouds', 'mosaico global')],
  ['Raios', weatherCheck('lightning', 'densidade de raios')],
  [
    'Ciclones',
    async () => {
      const res = await get('/api/cyclones');
      const n = countOf(json(res));
      return res.status === 200
        ? [
            'LIMITADO',
            `funciona (${n ?? 0} sistemas ativos), mas a NOAA só cobre Atlântico Norte e Pacífico; nada no Atlântico Sul`,
          ]
        : ['FALHA', `HTTP ${res.status}`];
    },
  ],
  [
    'Rotas',
    async () => {
      const res = await get(
        '/api/route?profile=car&coords=-46.6333,-23.5505;-46.3336,-23.9608&steps=1&lang=pt',
      );
      const body = json(res);
      const meters = body?.distanceM;
      const km = meters ? (meters / 1000).toFixed(0) : '?';
      const min = body?.durationS ? Math.round(body.durationS / 60) : '?';
      if (res.status !== 200 || !body?.ok)
        return [
          'FALHA',
          `HTTP ${res.status} ${res.body.toString('utf8').slice(0, 100)}`,
        ];
      return body.provider === 'tomtom'
        ? [
            'OK',
            `São Paulo → Santos: ${km} km, ${min} min com trânsito ao vivo (TomTom, +${Math.round((body.traffic?.delayS || 0) / 60)} min de lentidão, ${1 + (body.alternatives?.length || 0)} opções)`,
          ]
        : [
            'LIMITADO',
            `São Paulo → Santos: ${km} km, ${min} min sem trânsito (OpenStreetMap; TomTom indisponível ou cota do dia esgotada)`,
          ];
    },
  ],
  [
    'Busca de lugares',
    async () => {
      const res = await get('/api/br/search?q=01310-100');
      const first = json(res)?.results?.[0];
      const rev = json(
        await get('/api/br/reverse?lat=-23.5613&lon=-46.6560&level=bairro'),
      );
      return res.status === 200 && first
        ? [
            rev?.label ? 'OK' : 'LIMITADO',
            `CEP 01310-100 → ${first.name} (${first.detail}); centro do mapa → ${rev?.label || 'sem nome (Nominatim fora do ar)'}`,
          ]
        : ['FALHA', `HTTP ${res.status}`];
    },
  ],
  [
    'Ocorrências de trânsito',
    async () => {
      const body = json(
        await get('/api/br/ocorrencias?bbox=-46.75,-23.65,-46.55,-23.5'),
      );
      if (!body) return ['FALHA', 'resposta inválida'];
      if (body.semChave) return ['SEM CHAVE', 'TOMTOM_API_KEY'];
      if (body.budgetOut)
        return ['LIMITADO', 'limite diário do TomTom atingido'];
      const kinds = {};
      for (const i of body.items || [])
        kinds[i.label] = (kinds[i.label] || 0) + 1;
      return [
        body.failedCells ? 'LIMITADO' : 'OK',
        `centro de São Paulo: ${body.items?.length || 0} ocorrências (${Object.entries(
          kinds,
        )
          .slice(0, 4)
          .map(([k, v]) => `${v} ${k.toLowerCase()}`)
          .join(
            ', ',
          )})${body.failedCells ? `, ${body.failedCells} células falharam` : ''}`,
      ];
    },
  ],
  [
    'Ônibus em tempo real',
    async () => {
      const boxes = {
        Rio: '-43.3,-22.95,-43.1,-22.85',
        DF: '-48.0,-15.9,-47.8,-15.7',
        BH: '-44.0,-20.0,-43.9,-19.85',
        SP: '-46.7,-23.6,-46.6,-23.5',
      };
      const parts = [];
      let cities = [];
      for (const [name, box] of Object.entries(boxes)) {
        const body = json(await get(`/api/br/onibus?bbox=${box}`));
        cities = body?.cidades || cities;
        parts.push(`${name} ${body?.items?.length ?? 'erro'}`);
      }
      const status = Object.fromEntries(cities.map((c) => [c.id, c]));
      const failed = cities.filter((c) => c.status === 'falhou');
      const ok = cities.filter((c) => c.status === 'ok').length;
      return [
        !ok ? 'FALHA' : failed.length ? 'LIMITADO' : 'OK',
        `ônibus na área de teste: ${parts.join(', ')}; frota inteira: ${cities
          .map(
            (c) =>
              `${c.nome} ${c.status === 'ok' ? c.total : { sem_chave: 'sem chave', falhou: 'sem resposta', parado: 'não consultado' }[c.status] || c.status}`,
          )
          .join(
            ', ',
          )}${status.sp?.status === 'sem_chave' ? ' (SP precisa de SPTRANS_TOKEN)' : ''}`,
      ];
    },
  ],
  [
    'Qualidade do ar',
    async () => {
      const list = json(await get('/api/br/ar'))?.cidades || [];
      const sp = list.find((c) => c.nome === 'São Paulo');
      const worst = [...list].sort((a, b) => (b.aqi || 0) - (a.aqi || 0))[0];
      return list.length
        ? [
            'OK',
            `${list.length} cidades (CAMS); São Paulo ${sp?.aqi ?? '–'} (${sp?.nivel || '–'}); pior: ${worst?.nome} ${worst?.aqi}`,
          ]
        : ['FALHA', 'nenhuma cidade'];
    },
  ],
  [
    'Previsão do tempo',
    async () => {
      const body = json(await get('/api/br/tempo?lat=-23.55&lon=-46.63'));
      const today = body?.dias?.[0];
      return body?.agora && today
        ? [
            'OK',
            `São Paulo agora ${body.agora.temp}° (${body.agora.desc}); hoje ${today.min}–${today.max}°, chuva ${today.chuvaProb ?? '–'}%`,
          ]
        : [
            'FALHA',
            `resposta inválida (${JSON.stringify(body)?.slice(0, 120)})`,
          ];
    },
  ],
  [
    'Rádio',
    async () => {
      const res = await get('/api/radio/stations');
      const body = json(res);
      const list = Array.isArray(body) ? body : body?.stations || [];
      const br = list.filter(
        (s) =>
          (s.countrycode || s.countryCode || s.country_code) === 'BR' ||
          inBrazil(Number(s.geo_lat ?? s.lat), Number(s.geo_long ?? s.lon)),
      ).length;
      return res.status === 200 && list.length
        ? ['OK', `${list.length} rádios, ${br} no Brasil`]
        : ['FALHA', `HTTP ${res.status}`];
    },
  ],
];

export async function runLayerCheck(layers = LAYERS) {
  const tally = {};
  for (const [name, check] of layers) {
    const started = Date.now();
    let status;
    let detail;
    try {
      [status, detail] = await check();
    } catch (err) {
      status = 'FALHA';
      detail = err?.message || String(err);
    }
    tally[status] = (tally[status] || 0) + 1;
    console.log(
      `[camadas] ${status.padEnd(9)} ${name}: ${detail} · ${Date.now() - started} ms`,
    );
  }
  console.log(
    `[camadas] RESUMO ${new Date().toISOString()}: ` +
      Object.entries(tally)
        .map(([k, v]) => `${v} ${k}`)
        .join(', '),
  );
  return tally;
}

// Run when executed directly. Compare real paths: on the server the script is
// reached through the releases/current symlink.
const invokedDirectly = (() => {
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const tally = await runLayerCheck();
  process.exitCode = tally.FALHA ? 1 : 0;
}
