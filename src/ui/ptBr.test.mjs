import assert from 'node:assert/strict';
import test from 'node:test';
import { groupLabel, isPortugueseUi, layerLabel, stateLabel } from './ptBr.js';

const pt = { documentElement: { lang: 'pt-BR' } };
const en = { documentElement: { lang: 'en' } };

test('Portuguese labels apply only on a pt page', () => {
  assert.equal(isPortugueseUi(pt), true);
  assert.equal(isPortugueseUi(en), false);
  assert.equal(isPortugueseUi(undefined), false);
  assert.equal(groupLabel('Weather', pt), 'Clima e alertas');
  assert.equal(groupLabel('Weather', en), 'Weather');
  assert.equal(layerLabel('local-firms', pt), 'Focos de queimada');
  assert.equal(layerLabel('local-firms', en), null);
  assert.equal(layerLabel('unknown-layer', pt), null);
  assert.equal(stateLabel('ON', pt), 'LIGADA');
  assert.equal(stateLabel('ON', en), 'ON');
  assert.equal(stateLabel('SOMETHING', pt), 'SOMETHING');
});
