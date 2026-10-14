import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aircraftDetailsProxy,
  parseAdsbdbRoute,
  parsePlanespotters,
  parseReadsbAircraft,
} from '../server/providers/aircraft/details.js';

test('parsers keep the useful fields', () => {
  const live = parseReadsbAircraft({
    flight: 'AZU4501 ',
    r: 'PR-AUI',
    t: 'E195',
    alt_baro: 'ground',
    gs: 12,
    squawk: '7700',
    emergency: 'general',
    dbFlags: 1,
  });
  assert.equal(live.callsign, 'AZU4501');
  assert.equal(live.onGround, true);
  assert.equal(live.altBaroFt, 0);
  assert.equal(live.emergency, 'general');
  assert.equal(live.military, true);
  const route = parseAdsbdbRoute({
    response: {
      flightroute: {
        callsign: 'AZU4501',
        airline: { name: 'Azul' },
        origin: { iata_code: 'VCP', municipality: 'Campinas', elevation: 2170 },
        destination: null,
      },
    },
  });
  assert.equal(route.origin.iata, 'VCP');
  assert.equal(route.origin.elevationFt, 2170);
  assert.equal(route.destination, null);
  assert.equal(parsePlanespotters({ photos: [] }), null);
  assert.equal(
    parsePlanespotters({
      photos: [
        {
          thumbnail_large: { src: 'https://x/y.jpg' },
          link: 'https://p/1',
          photographer: 'A',
        },
      ],
    }).thumb,
    'https://x/y.jpg',
  );
});

test('details route validates the hex and survives failing sources', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('planespotters')) throw new Error('down');
    if (url.includes('/aircraft/'))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: { aircraft: { registration: 'PR-XBB', type: 'A320' } },
        }),
      };
    if (url.includes('/hex/'))
      return {
        ok: true,
        status: 200,
        json: async () => ({ ac: [{ flight: 'TAM3097', squawk: '4212' }] }),
      };
    if (url.includes('/callsign/'))
      return { ok: false, status: 404, json: async () => ({}) };
    return { ok: false, status: 500 };
  };
  const plugin = aircraftDetailsProxy({ fetchImpl });
  let handler;
  plugin.configurePreviewServer({
    middlewares: { use: (_p, fn) => (handler = fn) },
  });
  const call = (url) =>
    new Promise((resolve) =>
      handler(
        { url, method: 'GET' },
        {
          writeHead(s) {
            this.s = s;
          },
          end(b) {
            resolve({ status: this.s, body: JSON.parse(b) });
          },
        },
      ),
    );
  assert.equal((await call('/?hex=zz')).status, 400);
  const ok = await call('/?hex=E4944F');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.aircraft.registration, 'PR-XBB');
  assert.equal(ok.body.callsign, 'TAM3097');
  assert.equal(ok.body.route, null);
  assert.equal(ok.body.photo, null);
  assert.ok(calls.some((u) => u.endsWith('/callsign/TAM3097')));
});
