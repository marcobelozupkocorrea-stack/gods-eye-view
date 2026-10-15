import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  acceptsBrotli,
  brotliCopyFor,
} from '../../server/providers/assetCache.js';
import { precompressDir } from '../../scripts/barreto-precompress.mjs';
import { createBusSource, normLine } from '../../server/providers/buses.js';
import { citySummary, createBusesLayer } from '../layers/buses/index.js';
import {
  boxAround,
  camerasNear,
  distanceKm,
  incidentSummary,
  rankIncidents,
} from '../ui/barreto/nearExtras.js';
import {
  cityCamera,
  CITY_LAYERS_OFF,
  CITY_LAYERS_ON,
} from '../ui/barreto/cityNow.js';
import { busSheet } from '../ui/barreto/detailsModel.js';
import { renderSheetHtml } from '../ui/barreto/details.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';

test('brotli copies: accepted encodings, safe paths, precompression', async () => {
  assert.equal(acceptsBrotli('gzip, deflate, br, zstd'), true);
  assert.equal(acceptsBrotli('gzip;q=1.0, br;q=0'), false);
  assert.equal(acceptsBrotli('gzip'), false);
  assert.equal(acceptsBrotli(undefined), false);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'br-'));
  mkdirSync(path.join(dir, 'assets'));
  mkdirSync(path.join(dir, 'cesium'));
  const big = 'const x = "barreto";\n'.repeat(3000);
  writeFileSync(path.join(dir, 'assets', 'index-abcdef12.js'), big);
  writeFileSync(path.join(dir, 'cesium', 'Cesium.js'), big);
  writeFileSync(path.join(dir, 'assets', 'small-abcdef12.js'), 'x');
  writeFileSync(
    path.join(dir, 'assets', 'pic-abcdef12.png'),
    Buffer.alloc(40_000),
  );
  const r = await precompressDir(dir, { quality: 5 });
  assert.equal(r.files, 2, 'only large text files');
  const copy = brotliCopyFor(dir, '/assets/index-abcdef12.js?v=1');
  assert.ok(copy && copy.type.startsWith('text/javascript'));
  assert.equal(
    zlib.brotliDecompressSync(readFileSync(copy.file)).toString(),
    big,
  );
  assert.ok(brotliCopyFor(dir, '/cesium/Cesium.js'));
  assert.equal(brotliCopyFor(dir, '/assets/small-abcdef12.js'), null);
  assert.equal(brotliCopyFor(dir, '/assets/pic-abcdef12.png'), null);
  assert.equal(brotliCopyFor(dir, '/assets/../../etc/passwd.js'), null);
  assert.equal(brotliCopyFor(dir, '/assets/%2e%2e/%2e%2e/x.js'), null);
});

test('buses: line filter shows the whole line, its route and a followed bus', async () => {
  assert.equal(normLine(' 474 '), '474');
  assert.equal(normLine('sp-8000 10'), 'SP-800010');
  const t = Date.parse('2026-10-15T11:30:00Z');
  let minute = 0;
  const feature = (prefixo, numero, lon, lat) => ({
    geometry: { coordinates: [lon, lat] },
    properties: {
      veiculo: { prefixo, numero },
      datalocal: '2026-10-15 08:29:00',
      velocidade: '20',
      direcao: '90',
    },
  });
  const src = createBusSource({
    now: () => t + minute * 61_000,
    env: {},
    fetchImpl: async () =>
      new Response(
        JSON.stringify([
          {
            features: [
              feature('a', '0.156', -47.9 + minute * 0.001, -15.8),
              feature('b', '0.156', -47.5, -15.6),
              feature('c', '0.999', -47.9, -15.8),
            ],
          },
        ]),
      ),
  });
  const box = [-48, -15.9, -47.8, -15.7];
  const plain = await src.inBox(box);
  assert.deepEqual(plain.items.map((i) => i.id).sort(), ['df:a', 'df:c']);
  assert.deepEqual(plain.linhasNaTela.sort(), ['0.156', '0.999']);
  minute = 1;
  const line = await src.inBox(box, { linha: '0.156' });
  assert.deepEqual(
    line.items.map((i) => i.id).sort(),
    ['df:a', 'df:b'],
    'whole line, also outside the box',
  );
  assert.equal(line.linha, '0.156');
  assert.ok(line.trajeto.length >= 3, 'route cells from both minutes');
  const followed = await src.inBox([-47.6, -15.7, -47.4, -15.5], {
    seguir: 'df:a',
  });
  assert.ok(
    followed.items.some((i) => i.id === 'df:a'),
    'followed bus always included',
  );
  assert.equal(followed.rastro.length, 2, 'two positions so far');
  assert.equal(src.trackOf('df:a').length, 2);
});

test('bus layer params and panel text', () => {
  const layer = createBusesLayer({ fetchImpl: async () => new Response('{}') });
  assert.deepEqual(layer.getParams(), { linha: null, seguir: null });
  layer.setParams({ linha: ' 474 ' });
  assert.equal(layer.getParams().linha, '474');
  let controls = layer.getRowControls();
  assert.equal(controls.chips[0].label, 'Linha 474 ✕');
  assert.deepEqual(controls.chips[0].params, { linha: null });
  layer.setParams({ seguir: 'rio:A1', linha: '' });
  controls = layer.getRowControls();
  assert.equal(controls.chips[0].label, 'Filtrar linha');
  assert.ok(controls.chips.some((c) => c.label === 'Parar de acompanhar'));
  assert.match(
    citySummary([
      { id: 'rio', nome: 'Rio de Janeiro', status: 'ok', total: 4423 },
      { id: 'sp', nome: 'São Paulo', status: 'sem_chave', total: 0 },
    ]),
    /^GPS real: Rio 4\.423 · SP: precisa de token$/,
  );
  layer.disable();
  assert.deepEqual(layer.getParams(), { linha: null, seguir: null });
});

test('near card helpers: incidents ranked, cameras by distance', () => {
  assert.ok(Math.abs(distanceKm(-23.55, -46.63, -22.9, -43.2) - 360) < 10);
  const [w, s, e, n] = boxAround(-23.5, -46.6, 3);
  assert.ok(e > w && n > s && Math.abs(n - s - 6 / 111) < 0.001);
  const items = [
    {
      kind: 'bloqueio',
      label: 'Via interditada',
      magnitude: 4,
      lat: -23.5,
      lon: -46.6,
    },
    {
      kind: 'acidente',
      label: 'Acidente',
      magnitude: 3,
      delayS: 900,
      lat: -23.51,
      lon: -46.6,
    },
    {
      kind: 'obra',
      label: 'Obra na pista',
      magnitude: 1,
      lat: -23.5,
      lon: -46.6,
    },
  ];
  assert.equal(rankIncidents(items, -23.5, -46.6)[0].kind, 'acidente');
  assert.equal(
    incidentSummary(items),
    'Via interditada: 1 · Acidente: 1 · Obra na pista: 1',
  );
  const cams = camerasNear(
    [
      { id: 'far', lat: -23.0, lon: -46.6 },
      { id: 'near', lat: -23.501, lon: -46.6 },
      { id: 'mid', lat: -23.52, lon: -46.6 },
      { id: 'bad' },
    ],
    -23.5,
    -46.6,
    5,
  );
  assert.deepEqual(
    cams.map((c) => c.id),
    ['near', 'mid'],
  );
});

test('city view: real layer ids, camera centred on the point', () => {
  const ids = new Set(LAYER_STATE_REGISTRY.map((e) => e.id));
  for (const id of [...CITY_LAYERS_ON, ...CITY_LAYERS_OFF])
    assert.ok(ids.has(id), `${id} is a registered layer`);
  const cam = cityCamera(-23.5, -46.6);
  assert.ok(cam.lat < -23.5 && cam.lat > -23.55, 'stands back to the south');
  assert.equal(cam.lon, -46.6);
  assert.ok(cam.height <= 8000, 'low enough for the traffic layer');
});

test('bus card offers follow and line filter as actions', () => {
  const s = busSheet({
    id: 'rio:A1',
    cidade: 'rio',
    linha: '474',
    modo: 'Ônibus',
    lat: -22.9,
    lon: -43.2,
  });
  assert.deepEqual(
    s.actions.filter(Boolean).map((a) => a.id),
    ['seguir', 'linha'],
  );
  const html = renderSheetHtml({
    ...s,
    sections: s.sections.filter(Boolean),
    links: [],
  });
  assert.match(html, /data-action="seguir"/);
  assert.match(html, /Ver só a linha 474/);
  const following = busSheet(
    { id: 'rio:A1', cidade: 'rio', linha: '474' },
    { following: true, lineFilter: '474' },
  );
  assert.equal(following.actions[0].label, 'Parar de acompanhar');
  assert.equal(following.actions[1].label, 'Mostrar todas as linhas');
});
