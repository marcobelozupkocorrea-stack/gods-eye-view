import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DETER_CLASSES,
  deterDateMs,
  formatAreaKm2,
  parseDeterFeatures,
  ringCentroid,
  sortDeterRows,
} from './deter.js';
import {
  cemadenEventKind,
  cemadenTimeMs,
  parseCemadenAlerts,
} from './cemaden.js';
import {
  buildCemadenCard,
  buildDeterCard,
  deterPixelSize,
} from '../layers/points/cards.js';
import { deterFeatureUrl } from '../../server/providers/deterAlerts.js';
import { brSnapshotProxy } from '../../server/providers/brSnapshotProxy.js';

const square = (lon, lat, d = 0.01) => [
  [
    [lon, lat],
    [lon + d, lat],
    [lon + d, lat + d],
    [lon, lat + d],
    [lon, lat],
  ],
];

// Shape of the TerraBrasilis WFS GeoJSON (Oct/2026).
const AMZ = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'deter_amz.39091_curr',
      geometry: { type: 'MultiPolygon', coordinates: [square(-46.77, -2.65)] },
      properties: {
        gid: '39091_curr',
        classname: 'DESMATAMENTO_CR',
        view_date: '2026-09-13',
        sensor: 'WFI',
        satellite: 'AMAZONIA-1',
        areamunkm: 0.4751,
        municipality: "Machadinho D'oeste",
        uf: 'RO',
        uc: null,
      },
    },
    {
      type: 'Feature',
      id: 'x',
      geometry: { type: 'MultiPolygon', coordinates: [square(-60, -9)] },
      properties: {
        gid: '2_curr',
        classname: 'CICATRIZ_DE_QUEIMADA',
        view_date: '2026-09-20',
        areamunkm: 3.2,
        municipality: 'LÁBREA',
        uf: 'am',
        uc: 'RESEX Ituxi',
      },
    },
    { type: 'Feature', geometry: null, properties: { gid: 'nogeom' } },
    {
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: [square(10, 50)] },
      properties: { gid: 'outside' },
    },
  ],
};

test('DETER polygons become one centred, classified point each', () => {
  const rows = parseDeterFeatures(AMZ, 'amz');
  assert.equal(rows.length, 2, 'no geometry and out-of-Brazil rows dropped');
  const [first, second] = rows;
  assert.equal(first.stableId, 'amz-39091_curr');
  assert.equal(first.label, DETER_CLASSES.DESMATAMENTO_CR.label);
  assert.equal(first.biome, 'Amazônia');
  assert.equal(first.municipality, "Machadinho D'Oeste");
  assert.ok(Math.abs(first.lon - -46.765) < 1e-6);
  assert.ok(Math.abs(first.lat - -2.645) < 1e-6);
  assert.equal(first.date, deterDateMs('2026-09-13'));
  assert.equal(second.uf, 'AM');
  assert.equal(second.municipality, 'Lábrea');
  assert.equal(second.protectedArea, 'RESEX Ituxi');
  assert.deepEqual(
    sortDeterRows(rows).map((r) => r.stableId),
    ['amz-2_curr', 'amz-39091_curr'],
    'newest first',
  );
});

test('centroids, areas and point sizes', () => {
  assert.deepEqual(ringCentroid(square(0, 0, 2)[0]), { lon: 1, lat: 1 });
  assert.equal(formatAreaKm2(0.0695), '0,07 km²');
  assert.equal(formatAreaKm2(3.21), '3,2 km²');
  assert.equal(formatAreaKm2(12.4), '12 km²');
  assert.ok(deterPixelSize({ areaKm2: 0 }) === 5);
  assert.ok(deterPixelSize({ areaKm2: 100 }) === 12);
});

test('DETER card reads in Portuguese with place, area, date and credit', () => {
  const [row] = parseDeterFeatures(AMZ, 'amz');
  const card = buildDeterCard(row);
  assert.equal(card.title, '🌳 DESMATAMENTO (CORTE RASO)');
  assert.deepEqual(card.details, [
    "Machadinho D'Oeste/RO · Amazônia",
    '0,48 km² · visto em 13/09/2026',
    'Satélite AMAZONIA-1 WFI',
    'Fonte: INPE · DETER',
  ]);
  assert.equal(card.accent, '#ff3b30');
});

test('the WFS request filters by view date server-side', () => {
  const url = new URL(deterFeatureUrl('deter-amz:deter_amz', '2026-09-13'));
  assert.equal(url.origin, 'https://terrabrasilis.dpi.inpe.br');
  assert.equal(url.searchParams.get('CQL_FILTER'), "view_date>='2026-09-13'");
  assert.equal(url.searchParams.get('outputFormat'), 'application/json');
});

// Shape of painelalertas.cemaden.gov.br/wsAlertas2 (Oct/2026).
const CEMADEN = {
  alertas: [
    {
      cod_alerta: 2880,
      datahoracriacao: '2026-10-02 11:25:51.874',
      ult_atualizacao: '2026-10-09 10:01:58.671',
      codibge: 4318002,
      evento: 'Risco Hidrológico - Alto',
      nivel: 'Alto',
      status: 1,
      uf: 'RS',
      municipio: 'SÃO BORJA',
      latitude: -28.7468,
      longitude: -55.7966,
    },
    {
      cod_alerta: 2901,
      datahoracriacao: '2026-10-05 08:00:00.000',
      ult_atualizacao: '2026-10-05 08:00:00.000',
      evento: 'Movimento de Massa - Moderado',
      nivel: 'Moderado',
      status: 1,
      uf: 'SP',
      municipio: 'UBATUBA',
      latitude: -23.43,
      longitude: -45.07,
    },
    { cod_alerta: 3, status: 0, latitude: -10, longitude: -50, nivel: 'Alto' },
  ],
};

test('Cemaden alerts keep active ones, most severe first, in Brasília time', () => {
  const rows = parseCemadenAlerts(CEMADEN);
  assert.deepEqual(
    rows.map((r) => r.stableId),
    ['cemaden-2880', 'cemaden-2901'],
  );
  assert.equal(rows[0].event, 'Risco Hidrológico');
  assert.equal(rows[0].municipality, 'São Borja');
  assert.equal(rows[0].created, Date.parse('2026-10-02T11:25:51-03:00'));
  assert.equal(
    cemadenEventKind('Movimento de Massa - Muito Alto'),
    'Movimento de Massa',
  );
  assert.ok(Number.isNaN(cemadenTimeMs('')));
  const card = buildCemadenCard(rows[0]);
  assert.equal(card.title, '⚠ RISCO HIDROLÓGICO · Alto');
  assert.deepEqual(card.details, [
    'São Borja/RS',
    'desde 02/10 11:25 · atualizado 09/10 10:01',
    'Fonte: Cemaden',
  ]);
});

test('snapshot proxy caches within TTL and serves stale on failure', async () => {
  let clock = 0;
  let calls = 0;
  let fail = false;
  const plugin = brSnapshotProxy({
    name: 'test',
    path: '/api/test',
    ttlMs: 100,
    now: () => clock,
    refresh: async () => {
      calls += 1;
      if (fail) throw new Error('down');
      return [{ id: calls }];
    },
  });
  let handler;
  plugin.configurePreviewServer({
    middlewares: { use: (_p, fn) => (handler = fn) },
  });
  const get = () =>
    new Promise((resolve) =>
      handler(
        { url: '/', method: 'GET' },
        {
          headersSent: false,
          writeHead(s) {
            this.s = s;
          },
          end(b) {
            resolve({ status: this.s, body: JSON.parse(b) });
          },
        },
      ),
    );
  assert.deepEqual((await get()).body.rows, [{ id: 1 }]);
  clock = 50;
  assert.deepEqual((await get()).body.rows, [{ id: 1 }]);
  assert.equal(calls, 1);
  clock = 200;
  fail = true;
  const stale = await get();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.deepEqual(stale.body.rows, [{ id: 1 }]);
});

test('hashed bundle files are cached immutably, but only when served', async () => {
  const { assetCacheHeaders, isHashedAssetPath, IMMUTABLE_CACHE } =
    await import('../../server/providers/assetCache.js');
  assert.equal(isHashedAssetPath('/assets/index-CV_5zwPv.js'), true);
  assert.equal(isHashedAssetPath('/assets/names-DA56NpEe.json?x=1'), true);
  assert.equal(isHashedAssetPath('/index.html'), false);
  assert.equal(isHashedAssetPath('/api/firms'), false);
  let mw;
  assetCacheHeaders().configurePreviewServer({
    middlewares: { use: (fn) => (mw = fn) },
  });
  const run = (status, type = 'text/javascript') => {
    const headers = {};
    const res = {
      setHeader: (k, v) => (headers[k.toLowerCase()] = v),
      writeHead(code, h) {
        for (const [k, v] of Object.entries(h || {}))
          headers[k.toLowerCase()] = v;
        return code;
      },
    };
    mw({ method: 'GET', url: '/assets/index-CV_5zwPv.js' }, res, () => {});
    res.writeHead(status, {
      'Cache-Control': 'no-cache',
      'Content-Type': type,
    });
    return headers['cache-control'];
  };
  assert.equal(run(200), IMMUTABLE_CACHE);
  assert.equal(run(304), IMMUTABLE_CACHE);
  assert.equal(run(404), 'no-cache', 'errors keep the default');
  assert.equal(run(200, 'text/html'), 'no-cache', 'SPA fallback is not cached');
});
