import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionExpired } from './session.js';

test('only a 401 from the auth proxy counts as signed out', () => {
  assert.equal(sessionExpired(401), true);
  for (const status of [200, 202, 302, 404, 500, 0])
    assert.equal(sessionExpired(status), false);
});
