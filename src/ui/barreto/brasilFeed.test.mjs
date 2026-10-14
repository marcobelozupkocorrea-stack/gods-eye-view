import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countBySource,
  filterBrasilItems,
  foldText,
  sortBrasilItems,
  toBrasilItems,
} from './brasilFeed.js';

const square = (lat, lon) => [
  [
    [lon - 0.5, lat - 0.5],
    [lon + 0.5, lat - 0.5],
    [lon + 0.5, lat + 0.5],
    [lon - 0.5, lat + 0.5],
    [lon - 0.5, lat - 0.5],
  ],
];

const snapshot = {
  inmet: [
    {
      stableId: 'i1',
      event: 'Tempestade',
      severityLabel: 'Perigo',
      severityRank: 2,
      states: 'São Paulo, Minas Gerais',
      onset: 1_000,
      polygons: [square(-23, -46)],
    },
    { stableId: 'bad', event: 'Sem polígono', polygons: [] },
  ],
  defesa: [
    {
      stableId: 'd1',
      event: 'Chuvas intensas',
      severityLabel: 'Extremo',
      severityRank: 3,
      areaDesc: 'Litoral Norte',
      senderName: 'Defesa Civil de Ubatuba',
      onset: 500,
      polygons: [square(-23.4, -45.1)],
    },
  ],
  cemaden: [
    {
      stableId: 'c1',
      event: 'Movimento de massa',
      level: 'Moderado',
      rank: 1,
      municipality: 'Petrópolis',
      uf: 'RJ',
      lat: -22.5,
      lon: -43.2,
      updated: 2_000,
    },
  ],
  deter: [
    {
      stableId: 'x1',
      label: 'Desmatamento',
      className: 'DESMATAMENTO_CR',
      municipality: 'Altamira',
      uf: 'PA',
      biome: 'Amazônia',
      areaKm2: 1.5,
      lat: -3.2,
      lon: -52.2,
      date: 3_000,
    },
  ],
};

test('snapshots become one item list, skipping rows without a place', () => {
  const items = toBrasilItems(snapshot);
  assert.deepEqual(
    items.map((i) => i.key),
    ['inmet:i1', 'defesa:d1', 'cemaden:c1', 'deter:x1'],
  );
  const inmet = items[0];
  assert.equal(inmet.layerId, 'inmet-alerts');
  assert.equal(inmet.title, 'TEMPESTADE · Perigo');
  assert.ok(Math.abs(inmet.lat + 23) < 0.6 && Math.abs(inmet.lon + 46) < 0.6);
  assert.equal(items[1].detail, 'Defesa Civil de Ubatuba');
  assert.equal(items[2].subtitle, 'Petrópolis/RJ');
  assert.equal(items[3].severity, 2);
  assert.deepEqual(countBySource(items), {
    inmet: 1,
    defesa: 1,
    cemaden: 1,
    deter: 1,
  });
  assert.deepEqual(toBrasilItems({}), []);
});

test('most severe first, then most recent', () => {
  const sorted = sortBrasilItems(toBrasilItems(snapshot)).map((i) => i.key);
  assert.deepEqual(sorted, ['defesa:d1', 'deter:x1', 'inmet:i1', 'cemaden:c1']);
});

test('filters by source, severity and accent-free text', () => {
  const items = toBrasilItems(snapshot);
  const keys = (opts) => filterBrasilItems(items, opts).map((i) => i.key);
  assert.deepEqual(keys({ sources: ['cemaden'] }), ['cemaden:c1']);
  assert.deepEqual(keys({ minSeverity: 3 }), ['defesa:d1']);
  assert.deepEqual(keys({ text: 'petropolis' }), ['cemaden:c1']);
  assert.deepEqual(keys({ text: 'UBATUBA' }), ['defesa:d1']);
  // UF abbreviation matches "/RJ" and the full state name.
  assert.deepEqual(keys({ text: 'rj' }), ['cemaden:c1']);
  assert.deepEqual(keys({ text: 'sp' }), ['inmet:i1']);
  assert.deepEqual(keys({ text: 'pa amazonia' }), ['deter:x1']);
  assert.deepEqual(keys({ text: 'nada aqui' }), []);
  assert.equal(foldText('São Paulo'), 'sao paulo');
});
