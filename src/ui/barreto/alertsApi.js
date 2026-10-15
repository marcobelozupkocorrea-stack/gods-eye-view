/**
 * barreto.top: browser side of the alert hub (server/providers/alertas).
 */

async function getJson(url, { signal, method = 'GET', body } = {}, tries = 0) {
  const res = await fetch(url, {
    signal,
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  // 503 = the server is still reading the feeds right after a restart.
  if (res.status === 503 && method === 'GET' && tries < 6 && !signal?.aborted) {
    await new Promise((r) => setTimeout(r, 5000));
    return getJson(url, { signal, method, body }, tries + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const qs = (params) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {}))
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const fetchStates = (opts) => getJson('/api/br/alertas/estados', opts);
export const fetchCities = (uf, opts) =>
  getJson(`/api/br/alertas/cidades${qs({ uf })}`, opts);
export const fetchNear = (lat, lon, opts, raio = 0) =>
  getJson(
    `/api/br/alertas/perto${qs({ lat: lat.toFixed(3), lon: lon.toFixed(3), raio: raio || '' })}`,
    opts,
  );
export const pushSummaryNow = () =>
  getJson('/api/br/push/resumo', { method: 'POST', body: {} });
export const fetchHistory = (params, opts) =>
  getJson(`/api/br/alertas/historico${qs(params)}`, opts);
export const searchMunicipios = (q, opts) =>
  getJson(`/api/br/alertas/municipios${qs({ q })}`, opts);

export const pushState = (opts) => getJson('/api/br/push', opts);
export const pushSubscribe = (subscription, prefs) =>
  getJson('/api/br/push/inscrever', {
    method: 'POST',
    body: { subscription, prefs },
  });
export const pushUnsubscribe = (endpoint) =>
  getJson('/api/br/push/sair', { method: 'POST', body: { endpoint } });
export const pushPrefs = (prefs) =>
  getJson('/api/br/push/preferencias', { method: 'PUT', body: { prefs } });
export const pushTest = () =>
  getJson('/api/br/push/teste', { method: 'POST', body: {} });
export const pushLocation = (lat, lon) =>
  getJson('/api/br/push/local', { method: 'POST', body: { lat, lon } });

export const LEVEL_COLOR = Object.freeze({
  0: '#9ccc65',
  1: '#ffd60a',
  2: '#ff9f0a',
  3: '#ff3b30',
});

export const KIND_ICON = Object.freeze({
  chuva: 'rainy',
  granizo: 'weather_hail',
  vento: 'air',
  inundacao: 'flood',
  deslizamento: 'landslide',
  seco: 'water_drop',
  calor: 'thermostat',
  frio: 'ac_unit',
  incendio: 'local_fire_department',
  mar: 'waves',
  outro: 'warning',
});

export const KIND_OPTIONS = Object.freeze([
  ['', 'Todos os tipos'],
  ['chuva', 'Chuva forte'],
  ['inundacao', 'Enchente e alagamento'],
  ['deslizamento', 'Deslizamento'],
  ['vento', 'Vento forte'],
  ['granizo', 'Granizo'],
  ['seco', 'Tempo seco'],
  ['calor', 'Calor'],
  ['frio', 'Frio e geada'],
  ['incendio', 'Incêndio'],
  ['mar', 'Mar agitado'],
  ['outro', 'Outros'],
]);

const TIME = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  hour: '2-digit',
  minute: '2-digit',
});
const DATE_TIME = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const DAY_KEY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** "até 22:30" today, "até 16/10 08:00" another day. */
export function untilText(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const same = DAY_KEY.format(new Date(ms)) === DAY_KEY.format(new Date(now));
  return `até ${same ? TIME.format(new Date(ms)) : DATE_TIME.format(new Date(ms)).replace(',', '')}`;
}

export const dateTimeText = (ms) =>
  Number.isFinite(ms) ? DATE_TIME.format(new Date(ms)).replace(',', '') : '';

export function sourcesText(list) {
  const l = [...(list || [])];
  if (l.length <= 1) return l.join('');
  return `${l.slice(0, -1).join(', ')} e ${l[l.length - 1]}`;
}

export const fetchWeather = (lat, lon, opts) =>
  getJson(
    `/api/br/tempo${qs({ lat: lat.toFixed(2), lon: lon.toFixed(2) })}`,
    opts,
  );

const WEEKDAY = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'UTC',
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
});
/** "2026-10-15" → "qui., 15/10". */
export const dayText = (iso) =>
  WEEKDAY.format(new Date(`${iso}T12:00:00Z`)).replace('.', '');
