import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isConstrainedDevice,
  photorealisticTileOptions,
  viewerMsaaSamples,
} from './devicePerformance.js';

const device = ({ coarse = false, w = 1920, h = 1080, memory } = {}) => ({
  matchMedia: (q) => ({ matches: q === '(pointer: coarse)' && coarse }),
  screen: { width: w, height: h },
  navigator: memory === undefined ? {} : { deviceMemory: memory },
});

test('phones and low-memory devices get the lighter rendering budget', () => {
  const phone = device({ coarse: true, w: 390, h: 844 });
  const tablet = device({ coarse: true, w: 1024, h: 1366 });
  const desktop = device();
  const smallLaptop = device({ memory: 4 });
  assert.equal(isConstrainedDevice(phone), true);
  assert.equal(isConstrainedDevice(tablet), false);
  assert.equal(isConstrainedDevice(desktop), false);
  assert.equal(isConstrainedDevice(smallLaptop), true);
  assert.equal(viewerMsaaSamples(phone), 1);
  assert.equal(viewerMsaaSamples(desktop), 4);
  assert.equal(photorealisticTileOptions(phone).maximumScreenSpaceError, 24);
  assert.equal(
    photorealisticTileOptions(desktop).maximumScreenSpaceError,
    undefined,
  );
  assert.equal(
    isConstrainedDevice({}),
    false,
    'no browser globals: desktop budget',
  );
});
