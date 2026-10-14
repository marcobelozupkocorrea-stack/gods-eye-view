import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aircraftSheet,
  capAlertSheet,
  deterSheet,
  fireSheet,
  flagFromMmsi,
  fmtCoords,
  satelliteSheet,
  squawkMeaning,
  vesselSheet,
  vesselTypeLabel,
} from './detailsModel.js';

const rows = (sheet, title) =>
  Object.fromEntries(sheet.sections.find((s) => s.title === title)?.rows || []);

test('aircraft sheet merges the layer record with the server details', () => {
  const sheet = aircraftSheet(
    {
      icao24: 'e4944f',
      callsign: 'TAM3097 ',
      altitudeM: 2743,
      velocityMps: 131.5,
      track: 146.8,
      latitude: -23.63,
      longitude: -46.78,
      verticalRate: -5,
    },
    {
      hex: 'e4944f',
      aircraft: {
        registration: 'PR-XBB',
        manufacturer: 'Airbus',
        type: 'A320 271NSL',
        icaoType: 'A20N',
        owner: 'LATAM Brasil',
        ownerCountry: 'Brazil',
      },
      route: {
        callsignIata: 'JJ3097',
        airline: { name: 'TAM Brazilian Airlines' },
        origin: {
          iata: 'GYN',
          icao: 'SBGO',
          name: 'Santa Genoveva Airport',
          city: 'Goiânia',
          country: 'Brazil',
        },
        destination: {
          iata: 'CGH',
          icao: 'SBSP',
          name: 'Congonhas Airport',
          city: 'São Paulo',
          country: 'Brazil',
        },
      },
      live: {
        squawk: '4212',
        category: 'A3',
        selectedAltitudeFt: 8992,
        qnhHpa: 1012.8,
      },
      photo: {
        thumb: 'https://t.plnspttrs.net/x.jpg',
        link: 'https://www.planespotters.net/photo/1',
        photographer: 'Fulano',
      },
    },
  );
  assert.equal(sheet.title, 'TAM3097');
  assert.equal(sheet.subtitle, 'Airbus A320 271NSL · TAM Brazilian Airlines');
  assert.match(
    rows(sheet, 'Rota').Origem,
    /GYN \/ SBGO · Santa Genoveva Airport · Goiânia, Brazil/,
  );
  assert.match(rows(sheet, 'Rota').Voo, /TAM3097 \/ JJ3097/);
  assert.match(rows(sheet, 'Agora').Altitude, /^2\.743 m \(8\.999 pés\)$/);
  assert.match(rows(sheet, 'Agora').Vertical, /^Descendo 984 pés\/min/);
  assert.equal(rows(sheet, 'Agora').Squawk, '4212');
  assert.equal(rows(sheet, 'Aeronave').Matrícula, 'PR-XBB');
  assert.equal(rows(sheet, 'Aeronave').Categoria, 'Grande (34–136 t)');
  assert.equal(rows(sheet, 'Aeronave')['Transponder (ICAO)'], 'E4944F');
  assert.equal(sheet.photo.credit, 'Foto: Fulano · planespotters.net');
  assert.ok(
    sheet.links.some(
      (l) => l.href === 'https://globe.adsbexchange.com/?icao=e4944f',
    ),
  );
  assert.equal(sheet.alert, null);
});

test('emergency squawks are called out', () => {
  assert.equal(squawkMeaning('7700'), 'EMERGÊNCIA (7700)');
  const sheet = aircraftSheet(
    { icao24: 'abcdef' },
    { live: { squawk: '7600' } },
  );
  assert.equal(sheet.alert, '⚠ FALHA DE RÁDIO (7600)');
  const military = aircraftSheet(
    { icao24: 'ae1234', callsign: 'RCH123' },
    null,
    { military: true, loading: true },
  );
  assert.equal(military.kicker, 'AERONAVE MILITAR');
  assert.equal(military.loading, true);
  assert.ok(!military.links.some((l) => /flightaware/.test(l.href)));
});

test('vessel sheet: type, flag, size, ETA and nav status', () => {
  assert.equal(vesselTypeLabel('70'), 'Carga');
  assert.equal(vesselTypeLabel(84), 'Tanque (petroleiro/químico/gás)');
  assert.equal(flagFromMmsi('710000001'), 'Brasil');
  assert.equal(flagFromMmsi('12'), null);
  const sheet = vesselSheet(
    {
      mmsi: '710000001',
      name: 'NAVIO TESTE',
      type: '70',
      speed: 11.2,
      course: 200,
      heading: 511,
      lat: -23.95,
      lon: -46.31,
    },
    {
      lengthM: 120,
      beamM: 22,
      draughtM: 8.5,
      callSign: 'PPXY',
      destination: 'SANTOS',
      eta: { month: 10, day: 16, hour: 14, minute: 30 },
      navStatus: 'Navegando com motor',
      imo: '9300001',
    },
  );
  assert.equal(sheet.subtitle, 'Carga · Brasil');
  assert.equal(
    rows(sheet, 'Viagem')['Chegada prevista (ETA)'],
    '16/10 14:30 UTC',
  );
  assert.equal(rows(sheet, 'Navio').Comprimento, '120 m');
  assert.equal(
    rows(sheet, 'Agora').Proa,
    undefined,
    'heading 511 means "not available"',
  );
  assert.equal(rows(sheet, 'Agora')['Rumo no fundo'], '200° (S)');
});

test('satellite, fire and alert sheets keep only filled rows', () => {
  const sat = satelliteSheet({
    noradId: 25544,
    name: 'ISS (ZARYA)',
    group: 'stations',
    altitudeM: 418000,
    periodMin: 92.7,
    apogeeKm: 421,
    perigeeKm: 415,
    inclinationDeg: 51.64,
    speedKmS: 7.66,
  });
  assert.equal(sat.subtitle, 'Estação espacial · Órbita baixa (LEO)');
  assert.match(rows(sat, 'Órbita').Período, /^92,7 min \(15,5 voltas\/dia\)$/);
  const fire = fireSheet({
    lat: -10.5,
    lon: -55.2,
    frp: 42.3,
    confidence: 'h',
    night: true,
    place: { municipio: 'Sinop', estado: 'MT', bioma: 'Amazônia' },
  });
  assert.equal(fire.title, 'Sinop / MT');
  assert.equal(rows(fire, 'Detecção').Confiança, 'Alta');
  assert.equal(rows(fire, 'Detecção').Período, 'Noite');
  const cap = capAlertSheet({
    event: 'Tempestade',
    severityLabel: 'Perigo',
    states: 'SP',
    description: 'Chuva forte',
    web: 'https://alertas2.inmet.gov.br/1',
  });
  assert.equal(cap.kicker, 'AVISO DO INMET');
  assert.equal(rows(cap, 'O que diz').Descrição, 'Chuva forte');
  assert.ok(
    !cap.sections.some((s) => s.title === 'Quando'),
    'no times → no empty section',
  );
  const deter = deterSheet({
    label: 'Desmatamento',
    areaKm2: 1.5,
    municipality: 'Altamira',
    uf: 'PA',
  });
  assert.equal(rows(deter, 'Alerta').Área, '1,5 km² (150 ha)');
  assert.equal(fmtCoords(-23.5, -46.6), '23.5000° S, 46.6000° O');
});

test('earthquake sheet in Portuguese', async () => {
  const { earthquakeSheet, placePt, magnitudeWord } =
    await import('./detailsModel.js');
  assert.equal(placePt('15 km NW of Lima, Peru'), '15 km a NO de Lima, Peru');
  assert.equal(placePt('Fiji region'), 'Fiji region');
  assert.equal(magnitudeWord(5.4), 'Forte');
  const q = earthquakeSheet({
    stableId: 'us7000x',
    mag: 6.1,
    magType: 'mww',
    place: '30 km SE of Arica, Chile',
    depthKm: 95,
    tsunami: true,
    alert: 'yellow',
    felt: 120,
    status: 'reviewed',
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000x',
  });
  assert.equal(q.title, 'Magnitude 6,1 mww');
  assert.equal(q.subtitle, '30 km a SL de Arica, Chile');
  assert.match(q.alert, /tsunami/);
  assert.equal(rows(q, 'Evento').Profundidade, '95 km (intermediária)');
  assert.equal(rows(q, 'Impacto')['Alerta PAGER'], 'Amarelo (impacto local)');
  assert.equal(rows(q, 'Dados').Situação, 'Revisado por sismólogo');
  assert.equal(q.accent, '#ff9800');
});

test('pt-BR panel groups put Brazilian alerts first and fold outside-Brazil layers', async () => {
  const { panelGroupsForPage, BRAZIL_PANEL_GROUPS } =
    await import('../ptBr.js');
  assert.equal(panelGroupsForPage({ documentElement: { lang: 'en' } }), null);
  const groups = panelGroupsForPage({ documentElement: { lang: 'pt-BR' } });
  assert.equal(groups[0].label, 'Brazil alerts');
  const outside = groups.at(-1);
  assert.equal(outside.collapsible, true);
  assert.ok(outside.ids.includes('weather-radar'));
  const all = BRAZIL_PANEL_GROUPS.flatMap((g) => g.ids);
  assert.equal(new Set(all).size, all.length, 'no layer listed twice');
});
