import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRadarCatalog,
  radarStamp,
} from '../../server/providers/brazilRadar.js';
import { validRadars } from '../layers/brazilRadar/index.js';

const NOW = Date.parse('2026-10-14T16:20:00Z');
const product = (over = {}) => ({
  key: 'decea/saoroque/cappi/cappi3km',
  title: 'CAPPI-3-km-(refletividade)',
  groups: ['DECEA', 'São-Roque'],
  bounds: [
    [-25.83, -49.58],
    [-21.33, -44.6],
  ],
  latest_time: '2026-10-14T16:00:00Z',
  direct_frame_url:
    'https://s0.cptec.inpe.br/radar/geoserver/decea/saoroque/cappi/cappi3km/DISSM_Nowcasting_R12534960_{stamp}.png',
  ...over,
});
const catalog = (products) => ({
  sources: [
    { slug: 'satelite', products: [] },
    { slug: 'radar', products },
  ],
});

test('radar stamps follow CPTEC file names', () => {
  assert.equal(radarStamp('2026-10-14T16:00:00Z'), '202610141600');
  assert.equal(radarStamp('2026-10-14T16:00:00.000Z'), '202610141600');
  assert.equal(radarStamp('2026-10-14 16:00'), null);
});

test('catalog keeps fresh CAPPI radars with safe frame URLs', () => {
  const radars = parseRadarCatalog(
    catalog([
      product(),
      product({
        key: 'cemaden/natal/cappi/cappi3km',
        groups: ['CEMADEN', 'Natal'],
        latest_time: '2026-10-10T16:00:00Z',
      }),
      product({ key: 'decea/gama/cappi/vil' }),
      product({
        key: 'sipam/manaus/cappi/cappi3km',
        direct_frame_url: 'https://evil.example/x_{stamp}.png',
      }),
    ]),
    NOW,
  );
  assert.equal(radars.length, 1);
  const [r] = radars;
  assert.equal(r.name, 'São Roque');
  assert.equal(r.owner, 'DECEA (Força Aérea)');
  assert.equal(r.stamp, '202610141600');
  assert.deepEqual(r.bounds, {
    west: -49.58,
    south: -25.83,
    east: -44.6,
    north: -21.33,
  });
  assert.deepEqual(validRadars({ schemaVersion: 1, radars }).length, 1);
});

test('client rejects malformed manifests', () => {
  assert.throws(() => validRadars({ radars: [] }));
  assert.deepEqual(
    validRadars({
      schemaVersion: 1,
      radars: [{ id: 'x', stamp: 'bad', bounds: {} }],
    }),
    [],
  );
});
