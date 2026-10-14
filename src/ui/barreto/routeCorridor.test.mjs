import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alertsAlongRoute,
  pointInPolygons,
  pointsNearRoute,
  rainAlongRoute,
  rainFromPixel,
  routeSamples,
} from './routeCorridor.js';
import { levelForHeight } from './places.js';
import { levelForResult, outerRings } from './searchBar.js';
import { fmtDuration, localToIso } from './routePlanner.js';
import {
  cleanFavorites,
  photonResult,
  reverseRecord,
} from '../../../server/providers/barretoPlaces.js';

// A straight ~11 km line going north from (-46.6, -23.6).
const line = [
  [-46.6, -23.6],
  [-46.6, -23.5],
];

test('route samples every 400 m with km from the start', () => {
  const s = routeSamples(line);
  assert.ok(s.length >= 27 && s.length <= 30);
  assert.equal(s[0].km, 0);
  assert.ok(Math.abs(s.at(-1).km - 11.12) < 0.05);
});

test('warnings the route passes through, with km range', () => {
  const square = [
    [
      [
        [-46.7, -23.57],
        [-46.5, -23.57],
        [-46.5, -23.53],
        [-46.7, -23.53],
        [-46.7, -23.57],
      ],
    ],
  ];
  assert.equal(pointInPolygons(-46.6, -23.55, square), true);
  assert.equal(pointInPolygons(-46.6, -23.6, square), false);
  const hits = alertsAlongRoute(
    routeSamples(line),
    [
      {
        event: 'Tempestade',
        severityLabel: 'Perigo',
        severityRank: 2,
        polygons: square,
      },
      {
        event: 'Longe',
        polygons: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        ],
      },
    ],
    'INMET',
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, 'Tempestade');
  assert.ok(hits[0].fromKm > 3 && hits[0].toKm < 8);
});

test('points near the route', () => {
  const near = pointsNearRoute(
    routeSamples(line),
    [
      { id: 'cam1', lat: -23.55, lon: -46.6015 },
      { id: 'cam2', lat: -23.55, lon: -46.65 },
    ],
    400,
  );
  assert.deepEqual(
    near.map((c) => c.id),
    ['cam1'],
  );
  assert.ok(near[0].offRouteM < 200);
});

test('radar pixels become rain strength along the route', () => {
  assert.equal(rainFromPixel(0, 0, 0, 0), null);
  assert.equal(rainFromPixel(200, 200, 200, 255), null);
  assert.equal(rainFromPixel(0, 200, 60, 255).label, 'fraca');
  assert.equal(rainFromPixel(255, 220, 0, 255).label, 'moderada');
  assert.equal(rainFromPixel(255, 0, 0, 255).label, 'forte');
  const frame = {
    name: 'São Roque',
    bounds: { west: -47, south: -24, east: -46, north: -23 },
    sample: (lat) => (lat > -23.55 ? { rank: 3, label: 'forte' } : null),
  };
  const rain = rainAlongRoute(routeSamples(line), [frame]);
  assert.equal(rain.length, 1);
  assert.equal(rain[0].intensity, 'forte');
  assert.equal(rain[0].radar, 'São Roque');
});

test('levels, outlines and formatting helpers', () => {
  assert.equal(levelForHeight(5000), 'bairro');
  assert.equal(levelForHeight(100_000), 'cidade');
  assert.equal(levelForHeight(1_000_000), 'estado');
  assert.equal(levelForHeight(20_000_000), null);
  assert.equal(levelForResult({ type: 'city' }), 'cidade');
  assert.equal(levelForResult({ type: 'house' }), null);
  assert.equal(
    outerRings({ type: 'MultiPolygon', coordinates: [[[[0, 0]]], [[[1, 1]]]] })
      .length,
    2,
  );
  assert.equal(fmtDuration(95 * 60), '1 h 35 min');
  assert.match(
    localToIso('2026-10-14T18:00'),
    /^2026-10-14T18:00:00[+-]\d\d:\d\d$/,
  );
  assert.equal(localToIso('amanhã'), null);
});

test('server place helpers', () => {
  const r = photonResult({
    geometry: { coordinates: [-46.651918, -23.5648865] },
    properties: {
      type: 'house',
      housenumber: '1000',
      street: 'Avenida Paulista',
      district: 'Bela Vista',
      city: 'São Paulo',
      state: 'São Paulo',
      countrycode: 'BR',
    },
  });
  assert.equal(r.name, 'Avenida Paulista, 1000');
  assert.equal(r.detail, 'Bela Vista · São Paulo · SP');
  assert.equal(r.kind, 'Endereço');
  const rec = reverseRecord(
    {
      name: 'São Paulo',
      address: {
        suburb: 'Pinheiros',
        city: 'São Paulo',
        state: 'São Paulo',
        'ISO3166-2-lvl4': 'BR-SP',
        country: 'Brasil',
      },
      boundingbox: ['-24.0', '-23.3', '-46.8', '-46.3'],
      geojson: { type: 'Polygon', coordinates: [[[0, 0]]] },
    },
    'cidade',
  );
  assert.equal(rec.label, 'São Paulo – SP');
  assert.deepEqual(rec.bbox, [-46.8, -24, -46.3, -23.3]);
  assert.equal(rec.polygon.type, 'Polygon');
  assert.equal(
    reverseRecord(
      {
        address: { suburb: 'Pinheiros', city: 'São Paulo', state: 'São Paulo' },
      },
      'bairro',
    ).label,
    'Pinheiros · São Paulo – SP',
  );
  assert.deepEqual(
    cleanFavorites([
      { name: ' Casa ', lat: -23.5, lon: -46.6 },
      { name: '', lat: 1, lon: 1 },
      { name: 'X', lat: 100, lon: 1 },
    ]),
    [{ name: 'Casa', lat: -23.5, lon: -46.6, detail: '' }],
  );
});
