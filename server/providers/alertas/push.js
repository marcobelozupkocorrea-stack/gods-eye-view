/**
 * barreto.top: alert notifications (Web Push).
 *
 * - The VAPID key pair is created on first use and kept in /app/data/push.
 * - Each person (Caddy's X-Auth-Request-Email, hashed like the favourites)
 *   keeps their phone/computer subscriptions and preferences: minimum level,
 *   quiet hours, use "Meus lugares" and/or the last location the app sent.
 * - When the collector sees new alerts, every place of every person is
 *   checked; one notification per place and hazard, not repeated for six
 *   hours unless the level goes up (so INMET + Defesa Civil about the same
 *   storm ring once).
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { alertInArea, KIND_LABEL, LEVELS, SOURCE_LABEL } from './unify.js';

const REPEAT_MS = 6 * 3_600_000;
const LOCATION_MAX_AGE_MS = 3 * 86_400_000;

export const userHash = (email) =>
  createHash('sha256')
    .update(
      String(email || 'local')
        .trim()
        .toLowerCase(),
    )
    .digest('hex')
    .slice(0, 32);

export const DEFAULT_PREFS = Object.freeze({
  minRank: 2,
  silencio: { ativo: true, de: 22, ate: 7 },
  usarLugares: true,
  usarLocal: false,
  local: null,
  usarAreas: true,
  resumo: { ativo: false, hora: 7 },
});

/** Areas of interest: a named centre with a radius (km). Max 10. */
export function cleanAreas(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    const lat = Number(a?.lat);
    const lon = Number(a?.lon);
    const raioKm = Math.round(Number(a?.raioKm));
    const nome = typeof a?.nome === 'string' ? a.nome.trim().slice(0, 40) : '';
    if (!nome || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    out.push({
      nome,
      lat: Number(lat.toFixed(5)),
      lon: Number(lon.toFixed(5)),
      raioKm: Number.isFinite(raioKm) ? Math.max(1, Math.min(100, raioKm)) : 5,
    });
    if (out.length >= 10) break;
  }
  return out;
}

/** Validate preferences sent by the browser. */
export function cleanPrefs(input, previous = DEFAULT_PREFS) {
  const p = { ...DEFAULT_PREFS, ...previous };
  if (input && typeof input === 'object') {
    if ([1, 2, 3].includes(Number(input.minRank)))
      p.minRank = Number(input.minRank);
    if (input.silencio && typeof input.silencio === 'object') {
      const de = Number(input.silencio.de);
      const ate = Number(input.silencio.ate);
      p.silencio = {
        ativo: !!input.silencio.ativo,
        de: Number.isInteger(de) && de >= 0 && de < 24 ? de : p.silencio.de,
        ate:
          Number.isInteger(ate) && ate >= 0 && ate < 24 ? ate : p.silencio.ate,
      };
    }
    if ('usarLugares' in input) p.usarLugares = !!input.usarLugares;
    if ('usarLocal' in input) p.usarLocal = !!input.usarLocal;
    if ('usarAreas' in input) p.usarAreas = !!input.usarAreas;
    if (input.resumo && typeof input.resumo === 'object') {
      const hora = Number(input.resumo.hora);
      p.resumo = {
        ativo: !!input.resumo.ativo,
        hora:
          Number.isInteger(hora) && hora >= 4 && hora <= 12
            ? hora
            : (p.resumo?.hora ?? 7),
      };
    }
    if (!p.usarLocal) p.local = null;
  }
  return p;
}

const HOUR_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Sao_Paulo',
  hour: '2-digit',
  hourCycle: 'h23',
});
export const hourInBrazil = (ms) => Number(HOUR_FMT.format(new Date(ms)));

export function inQuietHours(silencio, ms) {
  if (!silencio?.ativo) return false;
  const h = hourInBrazil(ms);
  const { de, ate } = silencio;
  return de === ate
    ? false
    : de < ate
      ? h >= de && h < ate
      : h >= de || h < ate;
}

const TIME_FMT = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Notifications for one person.
 * @param {{ prefs: object, favorites: object[], sent: Map<string, {at:number, rank:number}> }} who
 * @param {object[]} alerts new unified alerts
 * @param {ReturnType<import('./unify.js').indexMunicipios>} index
 */
export function notificationsFor(
  { hash, prefs, favorites, areas = [], sent },
  alerts,
  index,
  at,
) {
  const places = [];
  if (prefs.usarLugares)
    for (const f of favorites || [])
      places.push({ name: f.name, lat: f.lat, lon: f.lon });
  if (
    prefs.usarLocal &&
    prefs.local &&
    at - (prefs.local.at || 0) < LOCATION_MAX_AGE_MS
  )
    places.push({
      name: 'sua localização',
      lat: prefs.local.lat,
      lon: prefs.local.lon,
      mine: true,
    });
  if (prefs.usarAreas !== false)
    for (const a of areas || [])
      places.push({ name: a.nome, lat: a.lat, lon: a.lon, raioKm: a.raioKm });
  if (!places.length) return [];
  const quiet = inQuietHours(prefs.silencio, at);
  const best = new Map();
  for (const place of places) {
    const city = index.nearest(place.lat, place.lon);
    for (const a of alerts) {
      if (a.rank < prefs.minRank) continue;
      if (quiet && a.rank < 3) continue;
      if (
        !alertInArea(
          a,
          place.lat,
          place.lon,
          place.raioKm || 0,
          index,
          city?.code,
        )
      )
        continue;
      const key = `${hash}|${place.mine ? '@local' : place.name}|${a.kind}`;
      const previous = sent.get(key);
      if (previous && at - previous.at < REPEAT_MS && previous.rank >= a.rank)
        continue;
      const current = best.get(key);
      if (!current || a.rank > current.alert.rank)
        best.set(key, { key, place, city, alert: a });
    }
  }
  return [...best.values()].map(({ key, place, city, alert }) => {
    const where = place.mine
      ? city
        ? `${city.nome}/${city.uf}`
        : 'sua região'
      : place.name;
    const until = alert.expires
      ? ` até ${TIME_FMT.format(new Date(alert.expires))}`
      : '';
    return {
      key,
      rank: alert.rank,
      payload: {
        title: `${LEVELS[alert.rank]} · ${KIND_LABEL[alert.kind]} em ${where}`,
        body: `${SOURCE_LABEL[alert.source]}: ${alert.event}${until}${
          city && !place.mine ? ` · ${city.nome}/${city.uf}` : ''
        }`,
        tag: key.split('|').slice(1).join('|'),
        rank: alert.rank,
        url: `/?origem=notificacao&abrir=alertas&alerta=${encodeURIComponent(alert.id)}`,
      },
    };
  });
}

/**
 * Storage + sending. `webpush` is the web-push module (injected for tests).
 */
export function createPush({
  dir,
  favoritesDir,
  webpush,
  now = () => Date.now(),
  log = console,
} = {}) {
  const usersDir = path.join(dir, 'usuarios');
  const sentFile = path.join(dir, 'enviados.json');
  let keys = null;
  let sent = null;

  async function vapid() {
    if (keys) return keys;
    const file = path.join(dir, 'vapid.json');
    try {
      keys = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      keys = webpush.generateVAPIDKeys();
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(file, JSON.stringify(keys), { mode: 0o600 });
      log.info?.('[push] chaves VAPID criadas');
    }
    return keys;
  }

  async function loadSent() {
    if (sent) return sent;
    sent = new Map();
    try {
      for (const [k, v] of Object.entries(
        JSON.parse(await fsp.readFile(sentFile, 'utf8')),
      ))
        if (now() - v.at < REPEAT_MS * 2) sent.set(k, v);
    } catch {
      /* first run */
    }
    return sent;
  }
  async function saveSent() {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      sentFile,
      JSON.stringify(Object.fromEntries(sent)),
      'utf8',
    );
  }

  const userFile = (hash) => path.join(usersDir, `${hash}.json`);
  async function readUser(hash) {
    try {
      const u = JSON.parse(await fsp.readFile(userFile(hash), 'utf8'));
      return {
        subs: Array.isArray(u.subs) ? u.subs : [],
        prefs: cleanPrefs(null, { ...DEFAULT_PREFS, ...u.prefs }),
        areas: cleanAreas(u.areas),
        resumoEm: typeof u.resumoEm === 'string' ? u.resumoEm : null,
      };
    } catch {
      return {
        subs: [],
        prefs: { ...DEFAULT_PREFS },
        areas: [],
        resumoEm: null,
      };
    }
  }
  async function writeUser(hash, user) {
    await fsp.mkdir(usersDir, { recursive: true });
    await fsp.writeFile(
      userFile(hash),
      JSON.stringify({
        subs: user.subs,
        prefs: user.prefs,
        areas: user.areas || [],
        resumoEm: user.resumoEm || null,
      }),
      'utf8',
    );
  }
  async function favoritesOf(hash) {
    try {
      const data = JSON.parse(
        await fsp.readFile(path.join(favoritesDir, `${hash}.json`), 'utf8'),
      );
      return Array.isArray(data.favorites) ? data.favorites : [];
    } catch {
      return [];
    }
  }

  async function getState(hash) {
    const user = await readUser(hash);
    return {
      publicKey: (await vapid()).publicKey,
      inscrito: user.subs.length,
      prefs: user.prefs,
      lugares: (await favoritesOf(hash)).map((f) => f.name),
      areas: user.areas,
    };
  }

  async function getAreas(hash) {
    return (await readUser(hash)).areas;
  }
  async function setAreas(hash, list) {
    const user = await readUser(hash);
    user.areas = cleanAreas(list);
    await writeUser(hash, user);
    return user.areas;
  }

  /**
   * Morning summary: for everyone who asked for it at this hour and has not
   * had it today, `compose(user)` builds the notification.
   */
  async function sendSummaries(compose, { force = null } = {}) {
    let files = [];
    try {
      files = (await fsp.readdir(usersDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return 0;
    }
    const at = now();
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
    }).format(new Date(at));
    const hour = hourInBrazil(at);
    let sentCount = 0;
    for (const file of files) {
      const hash = file.slice(0, -5);
      if (force && hash !== force) continue;
      const user = await readUser(hash);
      if (!user.subs.length) continue;
      if (!force) {
        if (!user.prefs.resumo?.ativo) continue;
        if (user.resumoEm === today || hour !== user.prefs.resumo.hora)
          continue;
      }
      let payload = null;
      try {
        payload = await compose({
          prefs: user.prefs,
          favorites: await favoritesOf(hash),
          areas: user.areas,
        });
      } catch (err) {
        log.warn?.('[push] resumo:', err?.message || err);
      }
      if (!payload) continue;
      if (await sendTo(hash, user, payload)) {
        sentCount += 1;
        if (!force) {
          user.resumoEm = today;
          await writeUser(hash, user);
        }
      }
    }
    return sentCount;
  }

  async function subscribe(hash, sub, ua) {
    if (
      !sub?.endpoint ||
      !/^https:\/\//.test(sub.endpoint) ||
      !sub.keys?.p256dh ||
      !sub.keys?.auth
    )
      throw new Error('invalid_subscription');
    const user = await readUser(hash);
    user.subs = user.subs.filter((s) => s.endpoint !== sub.endpoint);
    user.subs.push({
      endpoint: sub.endpoint,
      keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
      ua: String(ua || '').slice(0, 160),
      at: now(),
    });
    user.subs = user.subs.slice(-8);
    await writeUser(hash, user);
    return user.subs.length;
  }

  async function unsubscribe(hash, endpoint) {
    const user = await readUser(hash);
    user.subs = user.subs.filter((s) => s.endpoint !== endpoint);
    await writeUser(hash, user);
    return user.subs.length;
  }

  async function setPrefs(hash, input) {
    const user = await readUser(hash);
    user.prefs = cleanPrefs(input, user.prefs);
    await writeUser(hash, user);
    return user.prefs;
  }

  async function setLocation(hash, lat, lon) {
    const user = await readUser(hash);
    if (!user.prefs.usarLocal) return false;
    // ~1 km is enough to match an alert area; no more precision is kept.
    user.prefs.local = {
      lat: Math.round(lat * 100) / 100,
      lon: Math.round(lon * 100) / 100,
      at: now(),
    };
    await writeUser(hash, user);
    return true;
  }

  async function sendTo(hash, user, payload, { urgency = 'normal' } = {}) {
    const { publicKey, privateKey } = await vapid();
    let changed = false;
    let ok = 0;
    for (const sub of [...user.subs]) {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload), {
          vapidDetails: {
            subject: 'https://barreto.top',
            publicKey,
            privateKey,
          },
          TTL: 6 * 3600,
          urgency,
          timeout: 15_000,
        });
        ok += 1;
      } catch (err) {
        const code = err?.statusCode;
        if (code === 404 || code === 410) {
          user.subs = user.subs.filter((s) => s.endpoint !== sub.endpoint);
          changed = true;
        } else log.warn?.('[push] envio falhou:', code || err?.message || err);
      }
    }
    if (changed) await writeUser(hash, user);
    return ok;
  }

  async function test(hash) {
    const user = await readUser(hash);
    return sendTo(hash, user, {
      title: 'Barreto · notificações ligadas',
      body: 'É assim que os alertas vão chegar neste aparelho.',
      tag: 'teste',
      url: '/?origem=notificacao&abrir=alertas',
    });
  }

  /** New alerts → notifications for everyone subscribed. */
  async function dispatch(alerts, index) {
    if (!alerts.length) return 0;
    let files = [];
    try {
      files = (await fsp.readdir(usersDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return 0;
    }
    await loadSent();
    const at = now();
    let total = 0;
    for (const file of files) {
      const hash = file.slice(0, -5);
      const user = await readUser(hash);
      if (!user.subs.length) continue;
      const list = notificationsFor(
        {
          hash,
          prefs: user.prefs,
          favorites: await favoritesOf(hash),
          areas: user.areas,
          sent,
        },
        alerts,
        index,
        at,
      );
      for (const n of list.slice(0, 5)) {
        const delivered = await sendTo(hash, user, n.payload, {
          urgency: n.rank >= 3 ? 'high' : 'normal',
        });
        if (delivered) {
          sent.set(n.key, { at, rank: n.rank });
          total += 1;
        }
      }
    }
    if (total) await saveSent().catch(() => {});
    return total;
  }

  /** What the summary needs about one person (no subscription required). */
  async function summarySubject(hash) {
    const user = await readUser(hash);
    return {
      prefs: user.prefs,
      favorites: await favoritesOf(hash),
      areas: user.areas,
    };
  }

  return {
    vapid,
    getState,
    summarySubject,
    subscribe,
    unsubscribe,
    setPrefs,
    setLocation,
    test,
    dispatch,
    getAreas,
    setAreas,
    sendSummaries,
  };
}
