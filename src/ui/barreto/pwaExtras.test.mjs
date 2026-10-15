import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coordsIn, parseShared, sharedFromUrl } from './shareTarget.js';
import { advance, distanceToLine, inText, maneuverIcon } from './navigation.js';
import { agoText, offsetFor } from './timeline.js';
import { sameExceptCamera } from './savedViews.js';
import { barsFor } from './alertsViews.js';
import { keyBytes, pushSupport } from './notifySettings.js';
import { untilText, sourcesText } from './alertsApi.js';
import { stampBefore } from '../../layers/brazilRadar/index.js';

test('coordinates in map links and text', () => {
  assert.deepEqual(
    coordsIn('https://www.google.com/maps/place/X/@-23.5229,-46.1883,17z'),
    { lat: -23.5229, lon: -46.1883 },
  );
  assert.deepEqual(coordsIn('https://maps.google.com/?q=-23.55,-46.63'), {
    lat: -23.55,
    lon: -46.63,
  });
  assert.deepEqual(
    coordsIn('https://waze.com/ul?ll=-23.5%2C-46.6&navigate=yes'),
    { lat: -23.5, lon: -46.6 },
  );
  assert.deepEqual(coordsIn('geo:-22.9068,-43.1729?z=12'), {
    lat: -22.9068,
    lon: -43.1729,
  });
  assert.deepEqual(coordsIn('estou aqui -23.5505, -46.6333 vem'), {
    lat: -23.5505,
    lon: -46.6333,
  });
  assert.equal(coordsIn('ligue 11 99999-9999'), null);
  assert.equal(coordsIn('https://example.com/@0.0,0.0'), null);
});

test('what a share means', () => {
  assert.deepEqual(
    parseShared({
      title: 'Casa da vó',
      url: 'https://maps.google.com/?q=-23.55,-46.63',
    }),
    { lat: -23.55, lon: -46.63, name: 'Casa da vó' },
  );
  assert.deepEqual(
    parseShared({ text: 'Mercado Municipal https://maps.app.goo.gl/AbC123' }),
    { resolve: 'https://maps.app.goo.gl/AbC123', name: 'Mercado Municipal' },
  );
  assert.deepEqual(
    parseShared({ text: 'Rua Ipiranga, 200 - Centro, Mogi das Cruzes - SP' }),
    {
      query: 'Rua Ipiranga, 200 - Centro, Mogi das Cruzes - SP',
      name: 'Rua Ipiranga, 200 - Centro, Mogi das Cruzes - SP',
    },
  );
  assert.equal(
    parseShared({
      url: 'https://www.google.com/maps/search/?api=1&query=Parque%20Ibirapuera',
    }).query,
    'Parque Ibirapuera',
  );
  assert.equal(parseShared({}), null);
  assert.deepEqual(
    sharedFromUrl(
      'https://barreto.top/?compartilhado_texto=oi&compartilhado_link=https%3A%2F%2Fx',
    ),
    { title: '', text: 'oi', url: 'https://x' },
  );
  assert.equal(sharedFromUrl('https://barreto.top/?origem=app'), null);
});

test('navigation helpers', () => {
  assert.equal(maneuverIcon({ type: 'turn', modifier: 'left' }), 'turn_left');
  assert.equal(
    maneuverIcon({ type: 'turn', modifier: 'slight right' }),
    'turn_slight_right',
  );
  assert.equal(
    maneuverIcon({ type: 'roundabout', modifier: 'right' }),
    'roundabout_right',
  );
  assert.equal(maneuverIcon({ type: 'arrive' }), 'flag');
  assert.equal(maneuverIcon({ type: 'continue' }), 'straight');
  assert.equal(inText(10), 'agora');
  assert.equal(inText(287), 'em 290 m');
  assert.equal(inText(1234), 'em 1,2 km');
  const steps = [
    { lat: 0, lon: 0 },
    { lat: 0.001, lon: 0 },
    { lat: 0.002, lon: 0 },
    { lat: 0.003, lon: 0 },
  ];
  assert.equal(advance(steps, 1, 0.00101, 0), 2, 'reached step 1 → next is 2');
  assert.equal(advance(steps, 1, 0.0005, 0), 1);
  assert.equal(advance(steps, 3, 0.003, 0), 3, 'never past the last step');
  const line = [
    [-46.6, -23.5],
    [-46.5, -23.5],
  ];
  assert.ok(distanceToLine(-23.5, -46.55, line) < 1);
  assert.ok(Math.abs(distanceToLine(-23.501, -46.55, line) - 110) < 5);
});

test('timeline steps and labels', () => {
  assert.equal(offsetFor(18), 0);
  assert.equal(offsetFor(0), 180);
  assert.equal(offsetFor(15), 30);
  assert.equal(agoText(0), 'agora');
  assert.equal(agoText(40), 'há 40 min');
  assert.equal(agoText(120), 'há 2 h');
  assert.equal(agoText(150), 'há 2 h 30');
  assert.equal(
    stampBefore(
      { stamp: '202610150110', time: '2026-10-15T01:10:00.000Z' },
      30,
    ),
    '202610150040',
  );
  assert.equal(
    stampBefore({ stamp: '202610150110', time: 'x' }, 30),
    '202610150110',
  );
  assert.equal(
    stampBefore({ stamp: '202610150110', time: '2026-10-15T01:10:00.000Z' }, 0),
    '202610150110',
  );
});

test('saved views: only the camera differs?', () => {
  const a =
    'v=2&lat=-23.5&lon=-46.6&alt=900&heading=0&pitch=-90&roll=0&style=normal&l=abc';
  const b =
    'v=2&lat=-10&lon=-50&alt=20000&heading=10&pitch=-60&roll=0&style=normal&l=abc';
  const c =
    'v=2&lat=-23.5&lon=-46.6&alt=900&heading=0&pitch=-90&roll=0&style=noir&l=abc';
  assert.equal(sameExceptCamera(a, b), true);
  assert.equal(sameExceptCamera(a, c), false);
  assert.equal(sameExceptCamera(`#${a}`, b), true);
});

test('history bars group long periods into weeks', () => {
  const days = Array.from({ length: 30 }, (_, i) => ({
    dia: `2026-09-${String(i + 1).padStart(2, '0')}`,
    n: 1,
  }));
  assert.equal(barsFor(days).length, 30);
  const year = Array.from({ length: 365 }, (_, i) => ({ dia: `d${i}`, n: 2 }));
  const bars = barsFor(year);
  assert.ok(bars.length <= 45);
  assert.equal(
    bars.reduce((s, b) => s + b.n, 0),
    730,
  );
});

test('push helpers', () => {
  assert.deepEqual([...keyBytes('AQID')], [1, 2, 3]);
  assert.deepEqual([...keyBytes('_-8')], [255, 239]);
  const ios = pushSupport({
    navigator: { userAgent: 'iPhone', standalone: false },
    matchMedia: () => ({ matches: false }),
  });
  assert.equal(ios.ok, false);
  assert.match(ios.why, /Tela de Início/);
  const ok = pushSupport({
    navigator: { userAgent: 'Android', serviceWorker: {} },
    PushManager: function PushManager() {},
    Notification: { permission: 'default' },
    matchMedia: () => ({ matches: true }),
  });
  assert.equal(ok.ok, true);
  const denied = pushSupport({
    navigator: { serviceWorker: {} },
    PushManager: function PushManager() {},
    Notification: { permission: 'denied' },
  });
  assert.equal(denied.ok, false);
});

test('alert text helpers', () => {
  const now = Date.parse('2026-10-14T18:00:00Z');
  assert.equal(untilText(Date.parse('2026-10-14T23:30:00Z'), now), 'até 20:30');
  assert.equal(
    untilText(Date.parse('2026-10-16T11:00:00Z'), now),
    'até 16/10 08:00',
  );
  assert.equal(untilText(null), '');
  assert.equal(sourcesText(['INMET', 'Defesa Civil']), 'INMET e Defesa Civil');
  assert.equal(sourcesText(['A', 'B', 'C']), 'A, B e C');
  assert.equal(sourcesText(['A']), 'A');
});

test('the Cesium engine script is deferred, keeping its order', async () => {
  const { deferCesiumScript } =
    await import('../../../server/providers/assetCache.js');
  const html =
    '<head><script src="/cesium/Cesium.js"></script></head><script type="module" src="/assets/x.js"></script>';
  const out = deferCesiumScript(html);
  assert.match(out, /<script defer src="\/cesium\/Cesium\.js"><\/script>/);
  assert.ok(out.indexOf('Cesium.js') < out.indexOf('/assets/x.js'));
  assert.equal(deferCesiumScript('<p>x</p>'), '<p>x</p>');
});
