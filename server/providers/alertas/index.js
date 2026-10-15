/**
 * barreto.top: alert collector, history and notifications.
 *
 * Every 3 minutes the server reads its own INMET, Defesa Civil and Cemaden
 * endpoints (which keep their upstream caches), turns them into one model
 * (unify.js), writes new alerts to the history and sends notifications.
 *
 *   GET  /api/br/alertas/estados                → states with active alerts
 *   GET  /api/br/alertas/cidades?uf=SP          → cities of a state, merged hazards
 *   GET  /api/br/alertas/perto?lat=&lon=        → what covers a point
 *   GET  /api/br/alertas/historico?dias=&uf=&cidade=&kind=&source=&minRank=
 *   GET  /api/br/alertas/municipios?q=          → municipality search (history filter)
 *   GET  /api/br/push                           → key, preferences, subscriptions
 *   POST /api/br/push/inscrever | /sair | /teste | /local
 *   PUT  /api/br/push/preferencias
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import { barretoDataDir } from '../barretoPlaces.js';
import { createHistory } from './history.js';
import { createPush, userHash } from './push.js';
import { composeSummary } from './summary.js';
import { weatherNow } from '../weatherNow.js';
import { incidentSource } from '../trafficIncidents.js';
import {
  alertsNear,
  citiesOfState,
  foldText,
  indexMunicipios,
  publicAlert,
  statesSummary,
  unifyAlerts,
} from './unify.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLL_MS = 3 * 60_000;
const FIRST_POLL_MS = 15_000;

let municipiosIndex = null;
export function municipios() {
  if (!municipiosIndex)
    municipiosIndex = indexMunicipios(
      JSON.parse(
        readFileSync(path.join(HERE, '..', 'brMunicipios.json'), 'utf8'),
      ),
    );
  return municipiosIndex;
}

const SOURCES = Object.freeze({
  inmet: '/api/inmet/alerts',
  defesa: '/api/defesacivil/alerts',
  cemaden: '/api/cemaden/alerts',
});

export function barretoAlertsHub({
  dataDir = barretoDataDir(),
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  pollMs = POLL_MS,
} = {}) {
  const history = createHistory({ dir: path.join(dataDir, 'alertas'), now });
  const push = createPush({
    dir: path.join(dataDir, 'push'),
    favoritesDir: path.join(dataDir, 'favorites'),
    webpush,
    now,
  });
  let base = null;
  let snapshot = null; // { at, alerts }
  let inflight = null;
  let primed = false;
  let timer = null;
  let summaryTimer = null;

  async function collect() {
    if (!base) throw new Error('server not listening yet');
    const rows = {};
    const ok = new Set();
    await Promise.all(
      Object.entries(SOURCES).map(async ([key, url]) => {
        try {
          const res = await fetchImpl(base + url, {
            signal: AbortSignal.timeout(200_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          rows[key] = Array.isArray(body?.rows) ? body.rows : [];
          ok.add(key);
        } catch (err) {
          console.warn(`[alertas] ${key}:`, err?.message || err);
        }
      }),
    );
    // Keep the last good alerts of a source that failed this round.
    const previous = snapshot?.alerts || [];
    const alerts = unifyAlerts(rows, municipios()).concat(
      previous.filter((a) => !ok.has(a.source)),
    );
    const at = now();
    snapshot = { at, alerts, ok: [...ok] };
    const fresh = await history.observe(alerts, at, ok);
    if (primed && fresh.length) {
      try {
        const sent = await push.dispatch(fresh, municipios());
        if (sent)
          console.info(`[alertas] ${fresh.length} novos, ${sent} notificações`);
      } catch (err) {
        console.warn('[alertas] notificações:', err?.message || err);
      }
    }
    // The first round after a start only learns what is already active.
    primed = true;
    return snapshot;
  }

  const refresh = () => {
    if (!inflight)
      inflight = collect()
        .catch((err) => {
          console.warn('[alertas] coleta falhou:', err?.message || err);
          return snapshot;
        })
        .finally(() => {
          inflight = null;
        });
    return inflight;
  };

  async function current() {
    if (snapshot) return snapshot;
    return Promise.race([
      refresh(),
      new Promise((resolve) => setTimeout(() => resolve(null), 25_000)),
    ]);
  }

  function send(res, status, body, cache = 'no-store') {
    if (res.headersSent) return;
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cache,
    });
    res.end(JSON.stringify(body));
  }

  async function readJson(req, max = 16_384) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > max) throw new Error('too_large');
    }
    return body ? JSON.parse(body) : {};
  }

  async function alertasHandler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '');
    if (route === '/municipios') {
      const q = foldText(url.searchParams.get('q')).slice(0, 60);
      if (q.length < 2) return send(res, 200, { municipios: [] });
      const idx = municipios();
      const starts = [];
      const contains = [];
      for (const m of idx.list) {
        const name = foldText(m.nome);
        if (name.startsWith(q)) starts.push(m);
        else if (name.includes(q)) contains.push(m);
        if (starts.length >= 12) break;
      }
      return send(
        res,
        200,
        {
          municipios: [...starts, ...contains]
            .slice(0, 12)
            .map((m) => ({ code: m.code, nome: m.nome, uf: m.uf })),
        },
        'public, max-age=86400',
      );
    }
    if (route === '/historico') {
      const result = await history.query({
        dias: url.searchParams.get('dias'),
        uf: url.searchParams.get('uf'),
        cidade: url.searchParams.get('cidade'),
        kind: url.searchParams.get('kind'),
        source: url.searchParams.get('source'),
        minRank: Number(url.searchParams.get('minRank')) || 0,
        em: url.searchParams.get('em'),
        limit: url.searchParams.get('limit'),
      });
      return send(res, 200, result, 'private, max-age=60');
    }
    const snap = await current();
    if (!snap) return send(res, 503, { error: 'carregando' });
    const idx = municipios();
    const meta = { fetchedAt: snap.at, fontes: snap.ok };
    if (route === '/estados') {
      return send(
        res,
        200,
        {
          ...meta,
          total: snap.alerts.length,
          estados: statesSummary(snap.alerts, idx),
        },
        'private, max-age=60',
      );
    }
    if (route === '/cidades') {
      const uf = String(url.searchParams.get('uf') || '').toUpperCase();
      if (!idx.estados[uf]) return send(res, 400, { error: 'uf' });
      return send(
        res,
        200,
        {
          ...meta,
          uf,
          nome: idx.estados[uf],
          cidades: citiesOfState(snap.alerts, uf, idx),
        },
        'private, max-age=60',
      );
    }
    if (route === '/perto') {
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180
      )
        return send(res, 400, { error: 'ponto' });
      return send(
        res,
        200,
        {
          ...meta,
          ...alertsNear(
            snap.alerts,
            lat,
            lon,
            idx,
            Math.max(
              0,
              Math.min(100, Number(url.searchParams.get('raio')) || 0),
            ),
          ),
        },
        'private, max-age=60',
      );
    }
    if (route === '/alerta') {
      const id = url.searchParams.get('id');
      const a = snap.alerts.find((x) => x.id === id);
      return a
        ? send(res, 200, publicAlert(a))
        : send(res, 404, { error: 'nao_encontrado' });
    }
    return send(res, 404, { error: 'rota' });
  }

  async function pushHandler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    const hash = userHash(req.headers?.['x-auth-request-email'] || 'local');
    const method = req.method || 'GET';
    if (route === '/' && method === 'GET')
      return send(res, 200, await push.getState(hash));
    if (method !== 'POST' && method !== 'PUT')
      return send(res, 405, { error: 'metodo' });
    let body;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { error: 'json' });
    }
    if (route === '/inscrever') {
      try {
        const n = await push.subscribe(
          hash,
          body?.subscription,
          req.headers?.['user-agent'],
        );
        if (body?.prefs) await push.setPrefs(hash, body.prefs);
        return send(res, 200, { inscrito: n });
      } catch (err) {
        return send(res, 400, { error: err?.message || 'inscricao' });
      }
    }
    if (route === '/sair')
      return send(res, 200, {
        inscrito: await push.unsubscribe(hash, body?.endpoint),
      });
    if (route === '/preferencias')
      return send(res, 200, {
        prefs: await push.setPrefs(hash, body?.prefs || body),
      });
    if (route === '/local') {
      const lat = Number(body?.lat);
      const lon = Number(body?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon))
        return send(res, 400, { error: 'ponto' });
      return send(res, 200, {
        gravado: await push.setLocation(hash, lat, lon),
      });
    }
    if (route === '/teste')
      return send(res, 200, { enviados: await push.test(hash) });
    if (route === '/resumo')
      return send(res, 200, {
        enviados: await push.sendSummaries(summaryFor, { force: hash }),
      });
    return send(res, 404, { error: 'rota' });
  }

  /** The morning summary for one person, from the current snapshot. */
  const summaryFor = async (who) =>
    composeSummary(who, {
      alerts: (await current())?.alerts || [],
      index: municipios(),
      weather: weatherNow(),
      incidents: incidentSource(),
    });

  async function areasHandler(req, res) {
    const hash = userHash(req.headers?.['x-auth-request-email'] || 'local');
    if (req.method === 'PUT' || req.method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: 'json' });
      }
      return send(res, 200, { areas: await push.setAreas(hash, body?.areas) });
    }
    return send(res, 200, { areas: await push.getAreas(hash) });
  }

  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.warn('[alertas] erro:', err?.message || err);
      send(res, 500, { error: 'erro' });
    }
  };

  const install = (server) => {
    server.middlewares.use('/api/br/alertas', wrap(alertasHandler));
    server.middlewares.use('/api/br/push', wrap(pushHandler));
    server.middlewares.use('/api/br/areas', wrap(areasHandler));
    const httpServer = server.httpServer;
    const start = () => {
      const address = httpServer?.address?.();
      const port =
        typeof address === 'object' && address
          ? address.port
          : Number(process.env.PORT) || 4173;
      base = `http://127.0.0.1:${port}`;
      clearTimeout(timer);
      const loop = async () => {
        await refresh();
        timer = setTimeout(loop, pollMs);
        timer.unref?.();
      };
      timer = setTimeout(loop, FIRST_POLL_MS);
      timer.unref?.();
      // Morning summaries: look once a minute for people due at this hour.
      clearInterval(summaryTimer);
      summaryTimer = setInterval(() => {
        push.sendSummaries(summaryFor).then(
          (n) => n && console.info(`[alertas] ${n} resumos da manhã enviados`),
          (err) => console.warn('[alertas] resumo:', err?.message || err),
        );
      }, 60_000);
      summaryTimer.unref?.();
    };
    if (httpServer?.listening) start();
    else httpServer?.once?.('listening', start);
    httpServer?.once?.('close', () => {
      clearTimeout(timer);
      clearInterval(summaryTimer);
    });
  };

  return {
    name: 'barreto-alerts-hub',
    configureServer: install,
    configurePreviewServer: install,
    // For tests.
    _collect: collect,
    _setBase: (b) => {
      base = b;
    },
    _history: history,
    _push: push,
  };
}
