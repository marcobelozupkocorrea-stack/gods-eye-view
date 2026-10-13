import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INPE_SATELLITES_IN_FIRMS,
  inpeDailyFileName,
  parseInpeFocosCsv,
} from './inpeFocos.js';
import { filterTrailing24h } from './firmsCsv.js';
import { adaptFirmsRecords } from './firmsAdapt.js';
import { satelliteShortName } from './firmsLabels.js';

const HEADER =
  'id,lat,lon,data_hora_gmt,satelite,municipio,estado,pais,municipio_id,estado_id,pais_id,numero_dias_sem_chuva,precipitacao,risco_fogo,bioma,frp';
const CSV = [
  HEADER,
  '4a287721-0632-3def-babc-74564d619c07,  -6.570400, -61.398100,2026-10-13 00:00:00,GOES-19,MANICORÉ,AMAZONAS,Brasil,1302702,13,33,,,,Amazônia,71.9',
  '59af0758-b22a-39ac-8844-abf4f21e820d,  -1.659100, -54.474300,2026-10-13 14:35:00,NOAA-20,ALENQUER,PARÁ,Brasil,1500404,15,33,12,0.0,0.8,Amazônia,',
  'bad-row,abc,def,2026-10-13 01:00:00,GOES-19,X,Y,Brasil,1,2,33,,,,Cerrado,1',
  'short,row',
  '',
].join('\n');

test('INPE CSV maps to FIRMS-shaped records', () => {
  const records = parseInpeFocosCsv(CSV);
  assert.equal(records.length, 2);
  const [goes, noaa] = records;
  assert.equal(goes.lat, -6.5704);
  assert.equal(goes.lon, -61.3981);
  assert.equal(goes.acqDate, '2026-10-13');
  assert.equal(goes.acqTime, '0000');
  assert.equal(goes.satellite, 'GOES-19');
  assert.equal(goes.instrument, 'INPE');
  assert.equal(goes.frp, 71.9);
  assert.equal(goes.municipio, 'MANICORÉ');
  assert.equal(goes.estado, 'AMAZONAS');
  assert.equal(goes.bioma, 'Amazônia');
  assert.equal(noaa.acqTime, '1435');
  assert.equal(noaa.frp, 0, 'empty FRP becomes 0');
  assert.equal(noaa.riscoFogo, '0.8');
});

test('INPE records skip satellites FIRMS already publishes when asked', () => {
  const records = parseInpeFocosCsv(CSV, {
    skipSatellites: INPE_SATELLITES_IN_FIRMS,
  });
  assert.deepEqual(
    records.map((r) => r.satellite),
    ['GOES-19'],
  );
});

test('INPE parser rejects non-CSV bodies', () => {
  assert.equal(parseInpeFocosCsv('<html>404</html>'), null);
  assert.equal(parseInpeFocosCsv('latitude,longitude\n1,2'), null);
  assert.equal(parseInpeFocosCsv(undefined), null);
});

test('INPE records pass the shared 24 h filter and adapter', () => {
  const now = Date.UTC(2026, 9, 13, 18);
  const recent = filterTrailing24h(parseInpeFocosCsv(CSV), now);
  assert.equal(recent.length, 2);
  const fires = adaptFirmsRecords(recent);
  assert.equal(fires[0].sensor, 'INPE');
  assert.equal(fires[0].acqMs, Date.UTC(2026, 9, 13, 0, 0));
  assert.equal(fires[0].confidence, 0.6);
});

test('INPE daily file names use the UTC date', () => {
  assert.equal(
    inpeDailyFileName(Date.UTC(2026, 9, 13, 23, 59)),
    'focos_diario_br_20261013.csv',
  );
  assert.equal(
    inpeDailyFileName(Date.UTC(2026, 0, 2)),
    'focos_diario_br_20260102.csv',
  );
});

test('INPE satellite codes get short display names', () => {
  assert.equal(satelliteShortName('GOES-19'), 'G19');
  assert.equal(satelliteShortName('METOP-C'), 'MetOpC');
  assert.equal(satelliteShortName('MSG-03'), 'MSG3');
  assert.equal(satelliteShortName('NPP-375'), 'SNPP');
  assert.equal(satelliteShortName('NOAA-20'), 'N20');
});
