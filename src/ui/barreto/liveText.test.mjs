import assert from 'node:assert/strict';
import test from 'node:test';
import { translateLiveText } from './liveText.js';

test('layer meta lines and status chips read in Portuguese', () => {
  assert.equal(
    translateLiveText('INMET · Avisos · 29s ago'),
    'INMET · Avisos · há 29 s',
  );
  assert.equal(translateLiveText('CelesTrak · 1m ago'), 'CelesTrak · há 1 min');
  assert.equal(
    translateLiveText('Flights · never'),
    'OpenSky / ADSB.lol · nunca',
  );
  assert.equal(
    translateLiveText('Defesa Civil · IDAP · just now'),
    'Defesa Civil · IDAP · agora',
  );
  assert.equal(
    translateLiveText('INDISPONÍVEL · NASA FIRMS · LIVE · KEY REQUIRED'),
    'INDISPONÍVEL · NASA FIRMS · AO VIVO · PRECISA DE CHAVE',
  );
  assert.equal(
    translateLiveText('NASA FIRMS · LIVE · updated 8m ago'),
    'NASA FIRMS · AO VIVO · atualizado há 8 min',
  );
  assert.equal(translateLiveText('LOADING LIVE DATA'), 'CARREGANDO DADOS');
  assert.equal(
    translateLiveText('📍 Location: São Paulo'),
    '📍 Local: São Paulo',
  );
  assert.equal(
    translateLiveText('Algo já em português'),
    'Algo já em português',
  );
  assert.equal(translateLiveText('  '), '  ');
});

test('weather panel strings read in Portuguese', () => {
  assert.equal(
    translateLiveText('LATEST · newest per product'),
    'AGORA · imagem mais recente de cada camada',
  );
  assert.equal(translateLiveText('Clouds only'), 'Só nuvens');
  assert.equal(
    translateLiveText('Observed · 16:30 UTC · 21m ago'),
    'Observado · 16:30 UTC · há 21 min',
  );
  assert.equal(translateLiveText('1h 5m ago'), 'há 1 h 5 min');
  assert.equal(
    translateLiveText('Frame unavailable; previous observation retained'),
    'Imagem indisponível; mantendo a anterior',
  );
});
