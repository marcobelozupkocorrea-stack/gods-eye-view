import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  alertsNear,
  citiesOfState,
  indexMunicipios,
  kindOf,
  mergeHazards,
  statesSummary,
  unifyAlerts,
} from '../../server/providers/alertas/unify.js';
import {
  createHistory,
  dayKey,
} from '../../server/providers/alertas/history.js';
import {
  cleanPrefs,
  createPush,
  inQuietHours,
  notificationsFor,
} from '../../server/providers/alertas/push.js';

const idx = indexMunicipios(
  JSON.parse(
    readFileSync(
      new URL('../../server/providers/brMunicipios.json', import.meta.url),
      'utf8',
    ),
  ),
);

// A square around Mogi das Cruzes and São Paulo (lon -46.9…-46.0, lat -23.8…-23.3).
const square = [
  [
    [-46.9, -23.8],
    [-46.0, -23.8],
    [-46.0, -23.3],
    [-46.9, -23.3],
    [-46.9, -23.8],
  ],
];
const ROWS = {
  inmet: [
    {
      stableId: '9001',
      event: 'Tempestade',
      severityRank: 2,
      severityLabel: 'Perigo',
      states: 'São Paulo',
      onset: 1,
      expires: Date.parse('2026-10-15T01:30:00Z'),
      polygons: [square],
    },
  ],
  defesa: [
    {
      stableId: 'dc-1',
      event: 'Chuvas Intensas',
      severityRank: 3,
      severityLabel: 'Extremo',
      areaDesc: 'MOGI DAS CRUZES/SP',
      senderName: 'Defesa Civil Estadual de São Paulo',
      onset: 1,
      expires: Date.parse('2026-10-15T02:00:00Z'),
      polygons: [square],
    },
  ],
  cemaden: [
    {
      stableId: 'cemaden-77',
      event: 'Risco Hidrológico',
      level: 'Alto',
      rank: 2,
      lat: -23.52,
      lon: -46.19,
      municipality: 'Mogi das Cruzes',
      uf: 'SP',
      created: 1,
      updated: 2,
    },
  ],
};

test('hazard kinds from the words each source uses', () => {
  assert.equal(kindOf('Tempestade'), 'chuva');
  assert.equal(kindOf('Chuvas Intensas'), 'chuva');
  assert.equal(kindOf('Risco Hidrológico'), 'inundacao');
  assert.equal(kindOf('Movimento de Massa'), 'deslizamento');
  assert.equal(kindOf('Movimentos de Massa'), 'deslizamento');
  assert.equal(kindOf('VENDAVAL'), 'vento');
  assert.equal(kindOf('INUNDAÇÕES'), 'inundacao');
  assert.equal(kindOf('Baixa Umidade'), 'seco');
  assert.equal(kindOf('Ventos Costeiros'), 'vento');
  assert.equal(kindOf('Declínio de Temperatura'), 'frio');
  assert.equal(kindOf('Algo novo'), 'outro');
});

test('alerts get municipalities and states', () => {
  const alerts = unifyAlerts(ROWS, idx);
  assert.equal(alerts.length, 3);
  const mogi = idx.find('Mogi das Cruzes', 'SP');
  assert.ok(mogi);
  for (const a of alerts) {
    assert.ok(a.cities.includes(mogi.code), `${a.id} covers Mogi`);
    assert.deepEqual(a.ufs, ['SP']);
  }
  const inmet = alerts.find((a) => a.source === 'inmet');
  assert.ok(inmet.cities.length > 5, 'the square holds several municipalities');
});

test('INMET and Defesa Civil about the same storm merge into one hazard', () => {
  const alerts = unifyAlerts(ROWS, idx);
  const merged = mergeHazards(alerts.filter((a) => a.kind === 'chuva'));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].rank, 3);
  assert.deepEqual(merged[0].sources.sort(), ['Defesa Civil', 'INMET']);
  assert.equal(merged[0].until, Date.parse('2026-10-15T02:00:00Z'));
});

test('states and cities summaries', () => {
  const alerts = unifyAlerts(ROWS, idx);
  const [sp] = statesSummary(alerts, idx);
  assert.equal(sp.uf, 'SP');
  assert.equal(sp.alertas, 3);
  assert.equal(sp.rank, 3);
  const cities = citiesOfState(alerts, 'SP', idx);
  const mogi = cities.find((c) => c.nome === 'Mogi das Cruzes');
  assert.deepEqual(
    mogi.riscos.map((r) => r.kind),
    ['chuva', 'inundacao'],
  );
  assert.equal(cities[0].rank, 3);
});

test('near a point: covered alerts and the municipality', () => {
  const alerts = unifyAlerts(ROWS, idx);
  const near = alertsNear(alerts, -23.52, -46.19, idx);
  assert.equal(near.lugar.nome, 'Mogi das Cruzes');
  assert.equal(near.alertas.length, 3);
  assert.equal(near.riscos[0].kind, 'chuva');
  const far = alertsNear(alerts, -3.1, -60.0, idx);
  assert.equal(far.alertas.length, 0);
  assert.equal(far.lugar.uf, 'AM');
  assert.ok(!('polygons' in near.alertas[0]));
});

test('history: first sighting, closing, reopening and queries', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  let t = Date.parse('2026-10-10T15:00:00Z');
  const history = createHistory({ dir, now: () => t, log: {} });
  const alerts = unifyAlerts(ROWS, idx);
  const fresh = await history.observe(
    alerts,
    t,
    new Set(['inmet', 'defesa', 'cemaden']),
  );
  assert.equal(fresh.length, 3);
  t += 3_600_000;
  assert.equal((await history.observe(alerts, t)).length, 0);
  // Defesa Civil failed this round: its alert stays open.
  t += 3_600_000;
  await history.observe(
    alerts.filter((a) => a.source !== 'defesa'),
    t,
    new Set(['inmet', 'cemaden']),
  );
  // INMET dropped it: closed.
  t += 3_600_000;
  await history.observe(
    alerts.filter((a) => a.source === 'cemaden'),
    t,
    new Set(['inmet', 'defesa', 'cemaden']),
  );
  let q = await history.query({ dias: 7 });
  assert.equal(q.total, 3);
  assert.equal(q.itens.filter((i) => i.ativo).length, 1);
  assert.equal(q.porTipo[0].kind, 'chuva');
  assert.equal(q.porTipo[0].n, 2);
  assert.ok(
    q.porDia.some(
      (d) => d.dia === dayKey(Date.parse('2026-10-10T15:00:00Z')) && d.n === 3,
    ),
  );
  const mogi = idx.find('Mogi das Cruzes', 'SP');
  q = await history.query({ dias: 7, cidade: mogi.code, kind: 'inundacao' });
  assert.equal(q.total, 1);
  q = await history.query({ dias: 7, uf: 'RJ' });
  assert.equal(q.total, 0);

  // A fresh process reads the files back.
  const again = createHistory({ dir, now: () => t, log: {} });
  q = await again.query({ dias: 7 });
  assert.equal(q.total, 3);
  assert.equal(q.itens.filter((i) => i.ativo).length, 1);
  assert.equal((await again.observe(alerts, t)).length, 0, 'reopened, not new');
});

test('quiet hours and preferences', () => {
  const night = Date.parse('2026-10-15T03:00:00Z'); // 00:00 in Brasília
  const day = Date.parse('2026-10-15T15:00:00Z'); // 12:00
  const s = { ativo: true, de: 22, ate: 7 };
  assert.equal(inQuietHours(s, night), true);
  assert.equal(inQuietHours(s, day), false);
  assert.equal(inQuietHours({ ...s, ativo: false }, night), false);
  const p = cleanPrefs({
    minRank: 9,
    usarLocal: false,
    silencio: { ativo: true, de: 23, ate: 99 },
  });
  assert.equal(p.minRank, 2);
  assert.deepEqual(p.silencio, { ativo: true, de: 23, ate: 7 });
  assert.equal(p.local, null);
});

test('one notification per place and hazard, not repeated, quiet at night', () => {
  const alerts = unifyAlerts(ROWS, idx);
  const sent = new Map();
  const who = {
    hash: 'h',
    prefs: cleanPrefs({
      minRank: 2,
      silencio: { ativo: true, de: 22, ate: 7 },
    }),
    favorites: [{ name: 'Casa', lat: -23.52, lon: -46.19 }],
    sent,
  };
  const day = Date.parse('2026-10-14T18:00:00Z');
  const list = notificationsFor(who, alerts, idx, day);
  assert.deepEqual(list.map((n) => n.payload.title).sort(), [
    'Alto · Enchente e alagamento em Casa',
    'Extremo · Chuva forte em Casa',
  ]);
  for (const n of list) sent.set(n.key, { at: day, rank: n.rank });
  assert.equal(notificationsFor(who, alerts, idx, day + 3_600_000).length, 0);
  // Quiet hours: only the extreme one would pass.
  const night = Date.parse('2026-10-15T03:00:00Z');
  const fresh = { ...who, sent: new Map() };
  assert.deepEqual(
    notificationsFor(fresh, alerts, idx, night).map((n) => n.rank),
    [3],
  );
  // Nothing for a place far away.
  assert.equal(
    notificationsFor(
      { ...fresh, favorites: [{ name: 'Manaus', lat: -3.1, lon: -60 }] },
      alerts,
      idx,
      day,
    ).length,
    0,
  );
});

test('push storage: keys, subscription, dispatch and expired endpoints', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'push-'));
  const sentTo = [];
  const webpush = {
    generateVAPIDKeys: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }),
    async sendNotification(sub, payload) {
      if (sub.endpoint.endsWith('/gone')) {
        const e = new Error('gone');
        e.statusCode = 410;
        throw e;
      }
      sentTo.push([sub.endpoint, JSON.parse(payload).title]);
    },
  };
  const fs = await import('node:fs/promises');
  await fs.mkdir(path.join(dir, 'fav'), { recursive: true });
  const { userHash } = await import('../../server/providers/alertas/push.js');
  const hash = userHash('Marco@Example.com');
  await fs.writeFile(
    path.join(dir, 'fav', `${hash}.json`),
    JSON.stringify({ favorites: [{ name: 'Casa', lat: -23.52, lon: -46.19 }] }),
  );
  const t = Date.parse('2026-10-14T18:00:00Z');
  const push = createPush({
    dir: path.join(dir, 'push'),
    favoritesDir: path.join(dir, 'fav'),
    webpush,
    now: () => t,
    log: {},
  });
  const sub = (e) => ({
    endpoint: `https://push.example/${e}`,
    keys: { p256dh: 'k', auth: 'a' },
  });
  await push.subscribe(hash, sub('ok'), 'test');
  await push.subscribe(hash, sub('gone'), 'test');
  const state = await push.getState(hash);
  assert.equal(state.publicKey, 'PUB');
  assert.equal(state.inscrito, 2);
  assert.deepEqual(state.lugares, ['Casa']);
  const n = await push.dispatch(unifyAlerts(ROWS, idx), idx);
  assert.equal(n, 2);
  assert.equal(sentTo.length, 2);
  assert.equal(
    (await push.getState(hash)).inscrito,
    1,
    'expired endpoint removed',
  );
  // Same alerts again: nothing new is sent.
  assert.equal(await push.dispatch(unifyAlerts(ROWS, idx), idx), 0);
  await assert.rejects(push.subscribe(hash, { endpoint: 'http://x' }, ''));
});
