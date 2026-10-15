import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeCount, isNewerBuild, sheetSnap } from './appShellLogic.js';
import { registerServiceWorker } from './pwa.js';

test('sheet drag snaps to close, half or full', () => {
  assert.equal(sheetSnap(140, false), 'close');
  assert.equal(sheetSnap(10, false, 0.9), 'close');
  assert.equal(sheetSnap(140, true), 'half');
  assert.equal(sheetSnap(320, true), 'close');
  assert.equal(sheetSnap(-80, false), 'full');
  assert.equal(sheetSnap(-10, false, -0.8), 'full');
  assert.equal(sheetSnap(20, false), 'half');
  assert.equal(sheetSnap(-20, true), 'full');
});

test('tab badge mirrors the BRASIL AGORA count', () => {
  assert.equal(badgeCount('9'), '9');
  assert.equal(badgeCount('56 alertas'), '56');
  assert.equal(badgeCount('0'), '');
  assert.equal(badgeCount(''), '');
  assert.equal(badgeCount('140'), '99+');
});

test('a different main bundle means a newer build', () => {
  const html =
    '<script type="module" crossorigin src="/assets/index-NEW1.js"></script>';
  assert.equal(
    isNewerBuild(html, 'https://barreto.top/assets/index-OLD9.js'),
    true,
  );
  assert.equal(
    isNewerBuild(html, 'https://barreto.top/assets/index-NEW1.js'),
    false,
  );
  assert.equal(isNewerBuild('<html>login</html>', '/assets/x.js'), false);
  assert.equal(isNewerBuild(html, ''), false);
});

test('service worker is registered on the site but not on local previews', async () => {
  const calls = [];
  const navigator = {
    serviceWorker: {
      register: (url, opts) => {
        calls.push([url, opts.scope]);
        return Promise.resolve({});
      },
    },
  };
  const prev = globalThis.document;
  globalThis.document = { readyState: 'complete' };
  try {
    assert.equal(
      registerServiceWorker({ navigator, location: { hostname: '127.0.0.1' } }),
      null,
    );
    await registerServiceWorker({
      navigator,
      location: { hostname: 'barreto.top' },
    });
    assert.deepEqual(calls, [['/sw.js', '/']]);
    assert.equal(
      registerServiceWorker({
        navigator: {},
        location: { hostname: 'barreto.top' },
      }),
      null,
    );
  } finally {
    if (prev === undefined) delete globalThis.document;
    else globalThis.document = prev;
  }
});
