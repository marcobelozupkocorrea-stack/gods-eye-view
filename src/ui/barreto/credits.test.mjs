import assert from 'node:assert/strict';
import test from 'node:test';
import { creditStaysVisible, markCredits } from './credits.js';

test('logos and Google attribution stay visible when the credits fold', () => {
  assert.equal(creditStaysVisible({ hasImage: true }), true);
  assert.equal(creditStaysVisible({ text: 'Google Maps' }), true);
  assert.equal(creditStaysVisible({ text: 'Powered by Esri' }), true);
  assert.equal(creditStaysVisible({ text: '© OpenStreetMap' }), false);
  assert.equal(
    creditStaysVisible({ text: 'Upgrade for commercial use.' }),
    false,
  );
  assert.equal(creditStaysVisible({ text: ' • ' }), false);
  assert.equal(creditStaysVisible(), false);
});

test('folding marks only the logo and Google/Esri credits to stay', () => {
  const credit = (text, hasImage = false) => ({
    textContent: text,
    tagName: 'SPAN',
    dataset: {},
    querySelector: () => (hasImage ? {} : null),
  });
  const children = [
    credit('© OpenStreetMap'),
    credit(' • '),
    credit('Upgrade for commercial use.'),
    credit(' • '),
    credit('', true),
    credit('Powered by Esri'),
  ];
  const container = { querySelector: () => ({ children }) };
  markCredits(container);
  assert.deepEqual(
    children.map((c) => c.dataset.barretoKeep ?? null),
    [null, null, null, null, '1', '1'],
  );
});
