import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CETSP_POSITIONS,
  DERSP_CAMERAS_URL,
  CETSP_LIST_URL,
  cetSpSources,
  formatKm,
  loadCetSpSources,
  loadDerSpSources,
  parseCetSpCamList,
  parseDerSpCameras,
  titleCasePlace,
} from '../../server/providers/cctv/brazil.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';

// Shapes copied from the live DER-SP "Câmeras Online" API and CET page (Oct/2026).
const DER_ROWS = [
  {
    id: 1,
    rodovia: 'SP 008',
    km: 'KM 095+000',
    nome: 'Pedro Astenori Marigliani',
    local: 'BRAGANÇA PAULISTA',
    lat: -22.925636,
    lng: -46.5532,
    status: 1,
    sentido: 'SOCORRO',
  },
  {
    id: 18,
    rodovia: 'SP 123',
    km: 'KM 026+500',
    nome: 'Floriano Rodrigues Pinheiro',
    local: 'PINDAMONHANGABA',
    lat: -22.863694,
    lng: -45.602584,
    status: 1,
    sentido: 'CAMPOS DO JORDÃO',
  },
  {
    id: 28,
    rodovia: 'SP 125',
    km: 'KM 081+000',
    nome: 'Oswaldo Cruz',
    local: 'UBATUBA',
    lat: -23.366371,
    lng: -45.125379,
    status: 1,
    sentido: 'AMBOS',
  },
  {
    id: 3,
    rodovia: 'SP 055',
    km: 'KM 1+000',
    lat: -23.5,
    lng: -45.1,
    status: 2,
  },
  { id: 4, rodovia: 'SP 055', km: 'KM 1+000', lat: 0, lng: 0, status: 1 },
  { id: 'x;rm', rodovia: 'SP 055', lat: -23.5, lng: -45.1, status: 1 },
];

const CET_HTML = `<script type="text/javascript">
gTemFalha=false;var gCams = [];
gCams.push({pasta:184,titulo:'Brasil',subTitulo:'Av Brig Luis Antônio',detalhe:'Pr Armando S Oliveira',ativa:true,apImg:1,qtdeImagens:50});
gCams.push({pasta:210,titulo:'Brig Luis Antônio',subTitulo:'Al Santos',detalhe:'',ativa:true,apImg:1,qtdeImagens:50});
gCams.push({pasta:22,titulo:'Paulista',subTitulo:'Metrô Consolação',detalhe:'R Augusta',ativa:false,apImg:1,qtdeImagens:25});
gCams.push({pasta:999,titulo:'Nova',subTitulo:'Sem posição',detalhe:'',ativa:true,apImg:1,qtdeImagens:25});
var gUrlCams = "../Cams/";
</script>`;

test('titles and km markers read naturally in Portuguese', () => {
  assert.equal(
    titleCasePlace('SÃO LUIZ DO PARAITINGA'),
    'São Luiz do Paraitinga',
  );
  assert.equal(
    titleCasePlace("SANTA BÁRBARA D'OESTE"),
    "Santa Bárbara d'Oeste",
  );
  assert.equal(formatKm('KM 095+000'), 'km 95');
  assert.equal(formatKm('KM 026+500'), 'km 26,5');
  assert.equal(formatKm('KM 075+400'), 'km 75,4');
});

test('DER-SP rows become live HLS cameras; maintenance and bad rows are dropped', () => {
  const cams = parseDerSpCameras(DER_ROWS);
  assert.deepEqual(
    cams.map((c) => c.id),
    ['dersp-1', 'dersp-18', 'dersp-28'],
  );
  const [first, second, third] = cams;
  assert.equal(
    first.name,
    'SP 008 km 95 · Pedro Astenori Marigliani · sentido Socorro',
  );
  assert.equal(first.city, 'Bragança Paulista');
  assert.equal(first.feedType, 'hls');
  assert.equal(first.url, 'http://200.144.30.103:8084/hls/cam_1/stream.m3u8');
  assert.equal(second.code, 'SP 123 km 26,5');
  assert.equal(
    third.name,
    'SP 125 km 81 · Oswaldo Cruz',
    'AMBOS adds no direction',
  );
  // The catalog normaliser keeps the stream as a live feed.
  const normalized = normalizeSourceItem(first);
  assert.equal(normalized.feedType, 'hls');
  assert.equal(normalized.url, first.url);
});

test('CET list parses folders and names; only active, positioned cameras are served', () => {
  const entries = parseCetSpCamList(CET_HTML);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0], {
    folder: '184',
    title: 'Brasil',
    cross: 'Av Brig Luis Antônio',
    detail: 'Pr Armando S Oliveira',
    active: true,
  });
  const cams = cetSpSources(entries);
  assert.deepEqual(
    cams.map((c) => c.id),
    ['cetsp-184', 'cetsp-210'],
  );
  assert.equal(
    cams[0].name,
    'Brasil × Av Brig Luis Antônio (Pr Armando S Oliveira)',
  );
  assert.equal(
    cams[1].snapshotUrl,
    'https://cameras.cetsp.com.br/Cams/210/1.jpg',
  );
  assert.equal(cams[1].feedType, 'image');
  assert.deepEqual(
    { lat: cams[1].lat, lon: cams[1].lon },
    CETSP_POSITIONS[210],
  );
});

test('every hand-placed CET camera sits inside the city of São Paulo', () => {
  for (const [folder, at] of Object.entries(CETSP_POSITIONS)) {
    assert.ok(at.lat > -23.75 && at.lat < -23.35, `lat ${folder}`);
    assert.ok(at.lon > -46.83 && at.lon < -46.36, `lon ${folder}`);
  }
});

test('loaders fetch the official endpoints and fail closed', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (url === DERSP_CAMERAS_URL) return Response.json(DER_ROWS);
    if (url === CETSP_LIST_URL)
      return new Response(CET_HTML, {
        headers: { 'Content-Type': 'text/html' },
      });
    return new Response('nope', { status: 404 });
  };
  assert.equal((await loadDerSpSources({ fetchImpl })).length, 3);
  assert.equal((await loadCetSpSources({ fetchImpl })).length, 2);
  assert.deepEqual(seen, [DERSP_CAMERAS_URL, CETSP_LIST_URL]);

  const down = async () => new Response('', { status: 503 });
  assert.deepEqual(await loadDerSpSources({ fetchImpl: down }), []);
  assert.deepEqual(await loadCetSpSources({ fetchImpl: down }), []);
  const broken = async () => new Response('<html>not json</html>');
  assert.deepEqual(await loadDerSpSources({ fetchImpl: broken }), []);
});
