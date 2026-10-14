import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWeatherTimes } from '../../server/providers/weather.js';

const NOW = Date.parse('2026-10-14T16:20:00Z');

test('CPTEC times become the last 13 recent frames with fixed bounds', () => {
  const times = [];
  for (let m = 0; m <= 200; m += 10)
    times.push(
      new Date(NOW - 200 * 60_000 + m * 60_000)
        .toISOString()
        .replace('.000Z', 'Z'),
    );
  const value = parseWeatherTimes({ times }, 'clouds-br', NOW);
  assert.equal(value.times.length, 13);
  assert.equal(value.times.at(-1), '2026-10-14T16:20:00.000Z');
  assert.deepEqual(value.bounds, {
    west: -100,
    south: -56,
    east: -25.25,
    north: 12.5,
  });
  assert.ok(value.allowedTimes.length >= 13);
});

test('CPTEC times reject junk, future frames and unknown products', () => {
  assert.throws(() => parseWeatherTimes({ times: ['nope'] }, 'clouds-br', NOW));
  assert.throws(() =>
    parseWeatherTimes({ times: ['2026-10-14T18:00:00Z'] }, 'clouds-br', NOW),
  );
  assert.throws(() => parseWeatherTimes({}, 'clouds-br', NOW));
  assert.throws(() =>
    parseWeatherTimes({ times: ['2026-10-14T16:00:00Z'] }, 'radar', NOW),
  );
});
