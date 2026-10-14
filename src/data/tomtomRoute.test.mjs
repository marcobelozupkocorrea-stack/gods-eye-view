import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectTomTomRoutes,
  tomtomRouteUrl,
  fetchTomTomRoute,
} from '../../server/providers/places/tomtomRoute.js';
import { normalizeOsrmSteps, instructionForPt } from './routeSteps.js';
import {
  navigationAppUrl,
  normalizeRoutePayload,
  trafficColor,
} from '../layers/directions/index.js';

const points = (n, lat0 = -23.55, lon0 = -46.63) =>
  Array.from({ length: n }, (_, i) => ({
    latitude: lat0 - i * 0.01,
    longitude: lon0 + i * 0.005,
  }));
const route = (minutes, delay) => ({
  summary: {
    lengthInMeters: 79750,
    travelTimeInSeconds: minutes * 60,
    trafficDelayInSeconds: delay,
    noTrafficTravelTimeInSeconds: minutes * 60 - delay,
    departureTime: '2026-10-14T16:09:35-03:00',
    arrivalTime: '2026-10-14T17:45:50-03:00',
  },
  legs: [{ points: points(30) }],
  sections: [
    {
      sectionType: 'TRAFFIC',
      simpleCategory: 'JAM',
      magnitudeOfDelay: 2,
      delayInSeconds: 90,
      effectiveSpeedInKmh: 8,
      startPointIndex: 3,
      endPointIndex: 9,
    },
    {
      sectionType: 'TRAFFIC',
      simpleCategory: 'ROAD_WORK',
      magnitudeOfDelay: 4,
      delayInSeconds: 0,
      startPointIndex: 12,
      endPointIndex: 14,
      tec: { causes: [{ mainCauseCode: 3 }] },
    },
    {
      sectionType: 'TRAFFIC',
      simpleCategory: 'JAM',
      magnitudeOfDelay: 3,
      delayInSeconds: 300,
      startPointIndex: 15,
      endPointIndex: 18,
      tec: { causes: [{ mainCauseCode: 1 }, { mainCauseCode: 2 }] },
    },
    { sectionType: 'TRAFFIC', startPointIndex: 20, endPointIndex: 99 },
  ],
  guidance: {
    instructions: [
      {
        routeOffsetInMeters: 0,
        travelTimeInSeconds: 0,
        point: { latitude: -23.55, longitude: -46.63 },
        maneuver: 'DEPART',
        street: 'Rua Venceslau Brás',
        message: 'Partida da Rua Venceslau Brás',
      },
      {
        routeOffsetInMeters: 67,
        travelTimeInSeconds: 39,
        point: { latitude: -23.549, longitude: -46.632 },
        maneuver: 'TURN_LEFT',
        street: 'Praça da Sé',
        roadNumbers: ['SP-160'],
        message: 'Vire à esquerda para a Praça da Sé',
      },
      {
        routeOffsetInMeters: 79750,
        travelTimeInSeconds: minutes * 60,
        point: { latitude: -23.96, longitude: -46.33 },
        maneuver: 'ARRIVE',
        message: '',
      },
    ],
  },
});

test('TomTom routes become the /api/route payload with traffic', () => {
  const out = projectTomTomRoutes({ routes: [route(96, 1260), route(109, 0)] });
  assert.equal(out.provider, 'tomtom');
  assert.equal(out.durationS, 96 * 60);
  assert.equal(out.traffic.delayS, 1260);
  assert.equal(out.geometry.length, 30);
  assert.deepEqual(out.geometry[0], [-46.63, -23.55]);
  assert.equal(out.steps[1].type, 'turn');
  assert.equal(out.steps[1].modifier, 'left');
  assert.equal(out.steps[1].ref, 'SP-160');
  assert.equal(out.steps[0].distanceM, 67);
  assert.equal(out.steps[2].instruction, 'Chegada ao destino');
  assert.deepEqual(out.congestion[0], {
    from: 3,
    to: 9,
    causes: [],
    category: 'JAM',
    magnitude: 2,
    delayS: 90,
    speedKmh: 8,
  });
  assert.equal(out.congestion.length, 3);
  assert.deepEqual(
    out.incidents.map((i) => [i.kind, i.label, i.pointIndex]),
    [
      ['roadwork', 'Obras', 12],
      ['accident', 'Acidente', 15],
    ],
  );
  assert.equal(out.alternatives.length, 1);
  assert.equal(out.alternatives[0].durationS, 109 * 60);
  assert.equal(projectTomTomRoutes({ routes: [] }), null);

  const client = normalizeRoutePayload(out, 'car');
  assert.equal(client.provider, 'tomtom');
  assert.equal(client.alternatives.length, 1);
  assert.equal(client.congestion[0].to, 9);
  assert.equal(client.traffic.arrival, '2026-10-14T17:45:50-03:00');
});

test('request URL carries traffic, Portuguese and tolls', () => {
  const url = tomtomRouteUrl(
    [
      [-46.63, -23.55],
      [-46.33, -23.96],
    ],
    {
      key: 'k',
      lang: 'pt-BR',
      avoidTolls: true,
      depart: '2026-10-14T18:00:00-03:00',
    },
  );
  assert.match(url, /departAt=2026-10-14T18%3A00%3A00-03%3A00/);
  assert.match(
    url,
    /calculateRoute\/-23\.550000,-46\.630000:-23\.960000,-46\.330000\/json/,
  );
  assert.match(url, /traffic=true/);
  assert.match(url, /language=pt-BR/);
  assert.match(url, /avoid=tollRoads/);
  assert.match(url, /maxAlternatives=2/);
});

test('budget and failures fall back (null)', async () => {
  const spent = { take: async () => false };
  assert.equal(
    await fetchTomTomRoute(
      [
        [0, 0],
        [1, 1],
      ],
      { key: 'k', budget: spent },
    ),
    null,
  );
  const ok = { take: async () => true };
  const failing = async () => ({ ok: false, status: 403, body: null });
  assert.equal(
    await fetchTomTomRoute(
      [
        [0, 0],
        [1, 1],
      ],
      {
        key: 'k',
        budget: ok,
        fetchImpl: failing,
      },
    ),
    null,
  );
});

test('OSRM instructions in Portuguese', () => {
  assert.equal(
    instructionForPt({ type: 'turn', modifier: 'left', name: 'Rua Augusta' }),
    'Vire à esquerda para Rua Augusta',
  );
  assert.equal(
    instructionForPt({ type: 'roundabout', exit: 2, name: 'Av. Paulista' }),
    'Na rotatória, pegue a 2ª saída para Av. Paulista',
  );
  assert.equal(instructionForPt({ type: 'arrive' }), 'Chegada ao destino');
  const { steps } = normalizeOsrmSteps(
    {
      legs: [
        {
          steps: [
            {
              maneuver: { type: 'depart', location: [-46.6, -23.5] },
              name: 'Rua A',
            },
          ],
        },
      ],
    },
    { lang: 'pt' },
  );
  assert.equal(steps[0].instruction, 'Saia pela Rua A');
});

test('navigation app links and traffic colours', () => {
  const a = { lat: -23.55, lon: -46.63 };
  const b = { lat: -23.96, lon: -46.33 };
  assert.equal(
    navigationAppUrl('waze', a, b),
    'https://waze.com/ul?ll=-23.960000%2C-46.330000&navigate=yes',
  );
  assert.match(
    navigationAppUrl('google', a, b, 'foot'),
    /origin=-23\.550000,-46\.630000&destination=-23\.960000,-46\.330000&travelmode=walking/,
  );
  assert.equal(trafficColor(3, 'JAM'), '#ff3b30');
  assert.equal(trafficColor(0, 'ROAD_CLOSURE'), '#8b0000');
});

import { installRouteMiddleware } from '../../server/providers/places/routes.js';

test('car routes use TomTom first and fall back to OSRM', async () => {
  let handler;
  const seen = [];
  let tomtomUp = true;
  const json = (body, status = 200) => ({
    ok: status === 200,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: null,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)),
  });
  installRouteMiddleware(
    { use: (_p, fn) => (handler = fn) },
    {
      tomtomKey: 'k',
      tomtomBudget: { take: async () => true },
      fetchImpl: async (url) => {
        seen.push(url);
        if (url.includes('api.tomtom.com'))
          return tomtomUp ? json({ routes: [route(96, 1260)] }) : json({}, 500);
        return json({
          code: 'Ok',
          routes: [
            {
              geometry: {
                coordinates: [
                  [-46.63, -23.55],
                  [-46.33, -23.96],
                ],
              },
              distance: 80000,
              duration: 4500,
              legs: [],
            },
          ],
        });
      },
    },
  );
  const request = async (query) => {
    let payload;
    await handler(
      { url: `/?${query}`, socket: { remoteAddress: '127.0.0.9' } },
      { writeHead() {}, end: (b) => (payload = JSON.parse(b)) },
    );
    return payload;
  };
  const q = 'profile=car&coords=-46.63,-23.55;-46.33,-23.96&steps=1&lang=pt';
  const first = await request(q);
  assert.equal(first.provider, 'tomtom');
  assert.equal(first.traffic.delayS, 1260);
  tomtomUp = false;
  const cached = await request(q);
  assert.equal(cached.provider, 'tomtom', 'served from the 2-min cache');
  const fallback = await request(`${q}&avoid=tolls`);
  assert.equal(fallback.provider, undefined);
  assert.equal(fallback.distanceM, 80000);
  assert.ok(seen.some((u) => u.includes('routing.openstreetmap.de')));
  const walk = await request(
    'profile=foot&coords=-46.63,-23.55;-46.62,-23.56&steps=1',
  );
  assert.equal(walk.provider, undefined);
});

import { brazilianWording } from '../../server/providers/places/tomtomRoute.js';

test('TomTom Portuguese reads as Brazilian', () => {
  assert.equal(
    brazilianWording('Na rotunda, saia na segunda saída para a Avenida X'),
    'Na rotatória, pegue a segunda saída para a Avenida X',
  );
  assert.equal(
    brazilianWording('Partida da Rua Venceslau Brás'),
    'Saia da Rua Venceslau Brás',
  );
});
