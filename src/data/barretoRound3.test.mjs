import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cellsFor,
  createIncidentSource,
  brText,
  incidentRecord,
  parseBbox,
} from '../../server/providers/trafficIncidents.js';
import {
  aqiLevel,
  airPayload,
  createWeatherNow,
  forecastPayload,
} from '../../server/providers/weatherNow.js';
import {
  bboxAround,
  composeSummary,
  summaryLine,
} from '../../server/providers/alertas/summary.js';
import {
  alertInArea,
  indexMunicipios,
  unifyAlerts,
} from '../../server/providers/alertas/unify.js';
import {
  cleanAreas,
  cleanPrefs,
  notificationsFor,
} from '../../server/providers/alertas/push.js';
import {
  configureTrafficForBrazil,
  trafficHonesty,
  viewDrawsDots,
  viewDrawsLines,
} from '../layers/traffic/honesty.js';

const idx = indexMunicipios(
  JSON.parse(
    readFileSync(
      new URL('../../server/providers/brMunicipios.json', import.meta.url),
      'utf8',
    ),
  ),
);

test('incident cells: small views split, wide views refused', () => {
  assert.equal(cellsFor([-46.8, -23.8, -46.3, -23.4]).length, 4);
  assert.equal(cellsFor([-60, -30, -40, -10]), null);
  assert.deepEqual(
    parseBbox('-46.8,-23.8,-46.3,-23.4'),
    [-46.8, -23.8, -46.3, -23.4],
  );
  assert.equal(parseBbox('1,2,3'), null);
  assert.equal(parseBbox('5,0,1,1'), null);
});

test('TomTom incident → plain record in Portuguese', () => {
  const r = incidentRecord({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        [-46.6, -23.5],
        [-46.61, -23.51],
        [-46.62, -23.52],
      ],
    },
    properties: {
      id: 'abc',
      iconCategory: 1,
      magnitudeOfDelay: 3,
      events: [{ description: 'Acidente', code: 101 }],
      startTime: '2026-10-15T10:00:00Z',
      from: 'Av. A',
      to: 'Av. B',
      length: 820,
      delay: 600,
      roadNumbers: ['SP-070'],
    },
  });
  assert.equal(r.kind, 'acidente');
  assert.equal(r.label, 'Acidente');
  assert.equal(r.delayLabel, 'atraso grande');
  assert.equal(r.lat, -23.51);
  assert.deepEqual(r.roads, ['SP-070']);
  assert.equal(incidentRecord({ properties: {} }), null);
  assert.equal(brText('Encerrado/a'), 'Via interditada');
  assert.equal(brText('Trabalhos na estrada'), 'Obra na pista');
  assert.equal(brText('Duas faixas fechadas'), 'Duas faixas interditadas');
});

test('incident source: cache, dedupe and daily budget', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'inc-'));
  let calls = 0;
  const feature = (id, lon, lat) => ({
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { id, iconCategory: 9, magnitudeOfDelay: 1 },
  });
  const fetchImpl = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        incidents: [feature('x', -46.6, -23.5), feature('y', -46.4, -23.45)],
      }),
    );
  };
  const src = createIncidentSource({
    key: 'k',
    fetchImpl,
    dataDir: dir,
    limit: 3,
    now: () => 1000,
  });
  const a = await src.inBox([-46.8, -23.8, -46.3, -23.4]);
  assert.equal(a.items.length, 2, 'deduplicated across 4 cells');
  assert.equal(calls, 3, 'budget of 3 stops the fourth cell');
  assert.equal(a.budgetOut, true);
  const b = await src.inBox([-46.8, -23.8, -46.3, -23.4]);
  assert.equal(calls, 3, 'cached cells are not fetched again');
  assert.equal(b.items.length, 2);
  const none = await createIncidentSource({ key: '', dataDir: dir }).inBox([
    -46.8, -23.8, -46.3, -23.4,
  ]);
  assert.equal(none.semChave, true);
});

test('forecast payload and air levels', () => {
  const now = Date.parse('2026-10-15T13:00:00Z'); // 10:00 in Brasília
  const hours = Array.from(
    { length: 30 },
    (_, i) => `2026-10-15T${String(i % 24).padStart(2, '0')}:00`,
  );
  const p = forecastPayload(
    {
      current: {
        temperature_2m: 24.4,
        apparent_temperature: 26,
        relative_humidity_2m: 70,
        weather_code: 3,
        wind_speed_10m: 12,
      },
      hourly: {
        time: hours,
        temperature_2m: hours.map(() => 22),
        precipitation_probability: hours.map((_, i) => (i === 15 ? 80 : 10)),
        precipitation: hours.map(() => 0),
        weather_code: hours.map(() => 61),
      },
      daily: {
        time: ['2026-10-15', '2026-10-16'],
        weather_code: [80, 0],
        temperature_2m_max: [27.2, 30],
        temperature_2m_min: [17.8, 18],
        precipitation_probability_max: [80, 5],
        precipitation_sum: [12.4, 0],
      },
    },
    now,
  );
  assert.equal(p.agora.temp, 24);
  assert.equal(p.agora.desc, 'Nublado');
  assert.equal(p.horas[0].hora, '10:00');
  assert.equal(p.dias[0].desc, 'Pancadas de chuva');
  assert.equal(p.dias[0].max, 27);
  assert.equal(aqiLevel(42).nivel, 'Boa');
  assert.equal(aqiLevel(120).nivel, 'Ruim para sensíveis');
  assert.equal(aqiLevel(null), null);
  assert.equal(airPayload({ us_aqi: 61, pm2_5: 15.23 }).pm25, 15.2);
});

test('weather source batches the air-quality cities', async () => {
  const urls = [];
  const src = createWeatherNow({
    fetchImpl: async (url) => {
      urls.push(url);
      const n = new URL(url).searchParams.get('latitude').split(',').length;
      return new Response(
        JSON.stringify(
          Array.from({ length: n }, () => ({ current: { us_aqi: 55 } })),
        ),
      );
    },
  });
  const { cidades } = await src.airCities();
  assert.ok(cidades.length > 100);
  assert.ok(
    urls.length >= 3 && urls.length <= 4,
    'at most 50 cities per request',
  );
  assert.ok(
    cidades.some((c) => c.nome === 'Mogi das Cruzes' && c.nivel === 'Moderada'),
  );
});

const ROWS = {
  inmet: [
    {
      stableId: '1',
      event: 'Tempestade',
      severityRank: 2,
      severityLabel: 'Perigo',
      polygons: [
        [
          [
            [-46.3, -23.7],
            [-46.0, -23.7],
            [-46.0, -23.4],
            [-46.3, -23.4],
            [-46.3, -23.7],
          ],
        ],
      ],
    },
  ],
};

test('areas: an alert touching the circle counts', () => {
  const [a] = unifyAlerts(ROWS, idx);
  // São Paulo centre is outside the polygon but within 40 km of covered towns.
  assert.equal(alertInArea(a, -23.55, -46.63, 0, idx), false);
  assert.equal(alertInArea(a, -23.55, -46.63, 40, idx), true);
  assert.deepEqual(
    cleanAreas([
      { nome: ' Casa ', lat: -23.5, lon: -46.2, raioKm: 500 },
      { nome: '' },
    ]),
    [{ nome: 'Casa', lat: -23.5, lon: -46.2, raioKm: 100 }],
  );
  const prefs = cleanPrefs({
    resumo: { ativo: true, hora: 3 },
    usarAreas: false,
  });
  assert.deepEqual(prefs.resumo, { ativo: true, hora: 7 });
  assert.equal(prefs.usarAreas, false);
  const n = notificationsFor(
    {
      hash: 'h',
      prefs: cleanPrefs({}),
      favorites: [],
      areas: [{ nome: 'Capital', lat: -23.55, lon: -46.63, raioKm: 40 }],
      sent: new Map(),
    },
    unifyAlerts(ROWS, idx),
    idx,
    Date.parse('2026-10-15T15:00:00Z'),
  );
  assert.equal(n.length, 1);
  assert.match(n[0].payload.title, /Chuva forte em Capital/);
});

test('morning summary: forecast, alerts and incidents per area', async () => {
  const weather = {
    forPlace: async () => ({
      dias: [{ min: 17, max: 27, desc: 'Pancadas de chuva', chuvaProb: 80 }],
      horas: [{ hora: '15:00', chuvaProb: 80 }],
    }),
  };
  const incidents = {
    inBox: async () => ({ items: [{ kind: 'acidente' }, { kind: 'obra' }] }),
  };
  const out = await composeSummary(
    {
      prefs: {},
      favorites: [{ name: 'Trabalho', lat: -3.1, lon: -60.0 }],
      areas: [{ nome: 'Mogi', lat: -23.52, lon: -46.19, raioKm: 10 }],
    },
    { alerts: unifyAlerts(ROWS, idx), index: idx, weather, incidents },
  );
  assert.equal(out.tag, 'resumo');
  const [mogi, trabalho] = out.body.split('\n');
  assert.match(
    mogi,
    /^Mogi: 17–27°, pancadas de chuva, chuva 80% a partir das 15h · alerta: chuva forte \(alto\) · 2 ocorrências no trânsito \(1 acidente\/bloqueio\)$/,
  );
  assert.match(trabalho, /^Trabalho: 17–27°/);
  assert.ok(!/ocorrência/.test(trabalho), 'incidents only for areas');
  assert.equal(
    await composeSummary(
      { prefs: {}, favorites: [], areas: [] },
      { index: idx },
    ),
    null,
  );
  assert.equal(summaryLine({ name: 'X' }, {}), null);
  assert.deepEqual(bboxAround(0, 0, 111), [-1, -1, 1, 1]);
});

test('honest traffic view configuration', () => {
  assert.equal(trafficHonesty.view, 'pontos');
  configureTrafficForBrazil();
  assert.equal(trafficHonesty.view, 'vias');
  assert.equal(trafficHonesty.honest, true);
  assert.equal(viewDrawsDots('vias'), false);
  assert.equal(viewDrawsLines('vias'), true);
  assert.equal(viewDrawsDots('ambos'), true);
  assert.equal(viewDrawsLines('pontos'), false);
});

test('buses: parse each city feed, dedupe, drop stale and wide views', async () => {
  const { brasiliaTime, createBusSource, parseBh, parseDf, parseRio, parseSp } =
    await import('../../server/providers/buses.js');
  assert.equal(
    brasiliaTime('2026-10-15 08:24:56'),
    Date.parse('2026-10-15T11:24:56Z'),
  );
  assert.equal(
    brasiliaTime('20261015082648'),
    Date.parse('2026-10-15T11:26:48Z'),
  );
  const rio = parseRio([
    {
      id_veiculo: 'A1',
      servico: '898',
      modo: 'onibus',
      latitude: -22.9,
      longitude: -43.2,
      velocidade: 30,
      direcao: 90,
      datetime: '2026-10-15T11:10:44Z',
    },
    {
      id_veiculo: 'A1',
      servico: '898',
      modo: 'onibus',
      latitude: -22.91,
      longitude: -43.21,
      velocidade: 31,
      direcao: 91,
      datetime: '2026-10-15T11:10:40Z',
    },
    {
      id_veiculo: 'B2',
      servico: '10',
      modo: 'brt',
      latitude: 0,
      longitude: 0,
      datetime: '2026-10-15T11:10:40Z',
    },
  ]);
  assert.equal(rio.length, 1);
  assert.equal(rio[0].lat, -22.9);
  const df = parseDf([
    {
      NomeOperadora: 'Marechal',
      features: [
        {
          geometry: { coordinates: [-48.1, -15.8] },
          properties: {
            veiculo: { prefixo: '44', numero: '0.156', sentido: 'IDA' },
            direcao: '-317,32',
            velocidade: '17',
            datalocal: '2026-10-15 08:24:56',
          },
        },
      ],
    },
  ]);
  assert.equal(df[0].linha, '0.156');
  assert.equal(Math.round(df[0].dir), 43);
  assert.equal(df[0].sentido, 'ida');
  const bh = parseBh([
    {
      NV: '1',
      NL: '376',
      LT: '-19.88',
      LG: '-43.89',
      VL: '15',
      DG: '79',
      HR: '20261015082648',
    },
    {
      NV: '1',
      NL: '376',
      LT: '-19.87',
      LG: '-43.88',
      VL: '15',
      DG: '79',
      HR: '20261015082948',
    },
    { NV: '2', NL: '0', LT: '-19.8', LG: '-43.9', HR: '20261015082948' },
  ]);
  assert.equal(bh.length, 2);
  assert.equal(bh.find((b) => b.id === 'bh:1').lat, -19.87);
  assert.equal(bh.find((b) => b.id === 'bh:2').linha, null);
  const sp = parseSp({
    l: [
      {
        c: '8000-10',
        sl: 1,
        lt0: 'Lapa',
        lt1: 'Pça. Ramos',
        vs: [
          {
            p: 1234,
            a: true,
            ta: '2026-10-15T11:00:00Z',
            py: -23.5,
            px: -46.6,
          },
        ],
      },
    ],
  });
  assert.equal(sp[0].destino, 'Pça. Ramos');

  const now = Date.parse('2026-10-15T11:30:00Z');
  let calls = 0;
  const src = createBusSource({
    now: () => now,
    env: {},
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).includes('semob')) {
        return new Response(
          JSON.stringify([
            {
              features: [
                {
                  geometry: { coordinates: [-47.9, -15.8] },
                  properties: {
                    veiculo: { prefixo: 'novo' },
                    datalocal: '2026-10-15 08:28:00',
                  },
                },
                {
                  geometry: { coordinates: [-47.9, -15.8] },
                  properties: {
                    veiculo: { prefixo: 'velho' },
                    datalocal: '2026-07-01 08:00:00',
                  },
                },
              ],
            },
          ]),
        );
      }
      throw new Error('unexpected ' + url);
    },
  });
  const r = await src.inBox([-48, -15.9, -47.8, -15.7]);
  assert.deepEqual(
    r.items.map((i) => i.id),
    ['df:novo'],
  );
  assert.equal(r.cidades.find((c) => c.id === 'sp').status, 'sem_chave');
  await src.inBox([-48, -15.9, -47.8, -15.7]);
  assert.equal(calls, 1, 'cached for a minute; other cities not fetched');
  const wide = await src.inBox([-60, -30, -40, -10]);
  assert.equal(wide.tooWide, true);
  assert.equal(calls, 1);
});

test('more Brazilian cameras: parsers and the Praia Grande POST rule', async () => {
  const m = await import('../../server/providers/cctv/brazilMore.js');
  const { cctvUpstreamRequest, frameContentType } =
    await import('../../server/providers/cctv/media.js');
  const recife = m.parseRecife(
    '<script>let cameras = [{"IdCamera":158,"Codigo":"FC004","Endereco":"Herculano Bandeira - Sem. 137","LatLng":{"lat":-8.088917,"lng":-34.885222}},{"IdCamera":"x","LatLng":{}}];</script>',
  );
  assert.equal(recife.length, 1);
  assert.equal(recife[0].name, 'Herculano Bandeira');
  assert.equal(recife[0].feedType, 'image');
  assert.match(recife[0].url, /handler=Snapshot&Codigo=158$/);

  const pg = m.parsePraiaGrande([
    {
      Name: 'AV MARCOS FREIRE_CAM 02',
      Description: 'AV. MARCOS FREIRE 02 - Lateral (Internet)',
      Latitude: '-24.0',
      Longitude: '-46.4',
      Server: 'server-1',
      Id: 'abc',
    },
    { Name: 'X', Latitude: '0', Longitude: '0', Server: 'server-1' },
  ]);
  assert.equal(pg.length, 1);
  assert.equal(pg[0].name, 'Av. Marcos Freire 02 - Lateral');
  const post = cctvUpstreamRequest(pg[0].url);
  assert.equal(post.init.method, 'POST');
  assert.equal(
    post.url,
    'https://cameras.praiagrande.sp.gov.br/aovivo/get-snapshot/slideshow/AV%20MARCOS%20FREIRE_CAM%2002',
  );
  assert.equal(post.init.body, 'Server=server-1&Name=AV+MARCOS+FREIRE_CAM+02');
  assert.equal(cctvUpstreamRequest('https://example.com/x.jpg'), null);
  assert.equal(
    cctvUpstreamRequest('https://cameras.praiagrande.sp.gov.br/aovivo/api'),
    null,
  );

  const ita = m.parseItanhaem(`const cameras = [
    { id: 'orla02', label: 'AV PRESIDENTE VARGAS x AV DEMERVAL', lat: -24.187527, lng: -46.793547, url: 'https://www.itanhaem.sp.gov.br/aovivo/cameras/orla02.jpg' },
    { id: 'evil', label: 'X', lat: -24.1, lng: -46.7, url: 'https://evil.example/x.jpg' },
  ];`);
  assert.deepEqual(
    ita.map((c) => c.id),
    ['itanhaem-orla02'],
  );
  assert.equal(ita[0].cityId, 'prefeitura-de-itanhaem-itanhaem');

  const daer = m.parseDaerList({
    itens: {
      1: {
        ativo: true,
        urlamigavel: 'ers-030-km-24-4',
        titulo: 'ERS-030 KM 24,4',
        locais: [{ entidade: { pontos: '(-29.84,-50.66)' } }],
      },
      2: { ativo: true, urlamigavel: 'sem-ponto', titulo: 'ERS-122' },
    },
  });
  assert.deepEqual(daer, [
    {
      slug: 'ers-030-km-24-4',
      title: 'ERS-030 KM 24,4',
      lat: -29.84,
      lon: -50.66,
    },
  ]);
  assert.equal(
    m.parseDaerFrame(
      '<a class="cameraRodoviaLightBox"\n href="https://daer.kopp.com.br/sistrak-base-010/x/ptz_glorinha" title="t">',
    ),
    'https://daer.kopp.com.br/sistrak-base-010/x/ptz_glorinha',
  );
  assert.equal(
    m.parseDaerFrame(
      '<a class="cameraRodoviaLightBox" href="https://camerasdaer.perkons.com:60000/DAER-1">',
    ),
    null,
  );
  assert.equal(
    frameContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/x-icon'),
    'image/jpeg',
  );
  assert.equal(
    frameContentType(Buffer.from([0x89, 0x50]), 'image/png'),
    'image/png',
  );
});
