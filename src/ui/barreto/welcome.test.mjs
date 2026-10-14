import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WELCOME_MISSIONS,
  WELCOME_SESSION_KEY,
  WELCOME_STORAGE_KEY,
  shouldShowWelcome,
} from './welcome.js';

function stores(localValue = null, sessionValue = null) {
  const make = (initial, key) => {
    const map = new Map(initial ? [[key, initial]] : []);
    return {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => map.set(k, v),
      removeItem: (k) => map.delete(k),
    };
  };
  globalThis.localStorage = make(localValue, WELCOME_STORAGE_KEY);
  globalThis.sessionStorage = make(sessionValue, WELCOME_SESSION_KEY);
}

test('welcome shows once per session until suppressed, never on share links', () => {
  stores();
  assert.equal(shouldShowWelcome({ search: '' }), true);
  assert.equal(shouldShowWelcome({ search: '', hasShareState: true }), false);
  assert.equal(shouldShowWelcome({ search: '?welcome=0' }), false);
  assert.equal(shouldShowWelcome({ search: '?embed=1' }), false);
  stores(null, 'dismissed');
  assert.equal(shouldShowWelcome({ search: '' }), false);
  assert.equal(shouldShowWelcome({ search: '?welcome=1' }), true);
  stores('suppressed');
  assert.equal(shouldShowWelcome({ search: '' }), false);
  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
});

test('every mission has a unique id and a title', () => {
  const ids = WELCOME_MISSIONS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const mission of WELCOME_MISSIONS)
    assert.ok(mission.title && mission.text);
});
