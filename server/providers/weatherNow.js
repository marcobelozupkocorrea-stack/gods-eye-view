/**
 * barreto.top: forecast and air quality for a place, and air quality for
 * the main Brazilian cities. Data: Open-Meteo (forecast models and the
 * Copernicus CAMS air-quality model) — free, no key, CC BY 4.0.
 *
 *   GET /api/br/tempo?lat=&lon=  → { agora, horas[24], dias[7], ar, fonte }
 *   GET /api/br/ar               → { cidades: [{ nome, uf, lat, lon, aqi, nivel, … }] }
 *
 * Air quality here is a model estimate on a ~10–40 km grid, not a station
 * reading; the UI says so.
 */
import { municipios } from './alertas/index.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const PLACE_TTL_MS = 20 * 60_000;
const CITIES_TTL_MS = 45 * 60_000;

/** WMO weather code → [Portuguese, Material Symbols icon]. */
export const WEATHER_CODES = Object.freeze({
  0: ['Céu limpo', 'clear_day'],
  1: ['Quase limpo', 'partly_cloudy_day'],
  2: ['Parcialmente nublado', 'partly_cloudy_day'],
  3: ['Nublado', 'cloud'],
  45: ['Neblina', 'foggy'],
  48: ['Neblina com geada', 'foggy'],
  51: ['Garoa fraca', 'rainy'],
  53: ['Garoa', 'rainy'],
  55: ['Garoa forte', 'rainy'],
  56: ['Garoa congelante', 'weather_mix'],
  57: ['Garoa congelante', 'weather_mix'],
  61: ['Chuva fraca', 'rainy'],
  63: ['Chuva', 'rainy'],
  65: ['Chuva forte', 'rainy'],
  66: ['Chuva congelante', 'weather_mix'],
  67: ['Chuva congelante', 'weather_mix'],
  71: ['Neve fraca', 'weather_snowy'],
  73: ['Neve', 'weather_snowy'],
  75: ['Neve forte', 'weather_snowy'],
  77: ['Granizo fino', 'weather_hail'],
  80: ['Pancadas de chuva', 'rainy'],
  81: ['Pancadas de chuva', 'rainy'],
  82: ['Pancadas fortes', 'thunderstorm'],
  85: ['Pancadas de neve', 'weather_snowy'],
  86: ['Pancadas de neve', 'weather_snowy'],
  95: ['Trovoadas', 'thunderstorm'],
  96: ['Trovoadas com granizo', 'thunderstorm'],
  99: ['Trovoadas com granizo', 'thunderstorm'],
});
export const weatherText = (code) => WEATHER_CODES[code] || ['—', 'cloud'];

/** US AQI → Portuguese level + colour. */
export function aqiLevel(aqi) {
  if (!Number.isFinite(aqi)) return null;
  if (aqi <= 50) return { nivel: 'Boa', cor: '#30d158', rank: 0 };
  if (aqi <= 100) return { nivel: 'Moderada', cor: '#ffd60a', rank: 1 };
  if (aqi <= 150)
    return { nivel: 'Ruim para sensíveis', cor: '#ff9f0a', rank: 2 };
  if (aqi <= 200) return { nivel: 'Ruim', cor: '#ff3b30', rank: 3 };
  if (aqi <= 300) return { nivel: 'Muito ruim', cor: '#af52de', rank: 4 };
  return { nivel: 'Perigosa', cor: '#8e1b3d', rank: 5 };
}

/** Capitals and other large cities shown on the air-quality layer. */
export const AIR_CITIES = Object.freeze([
  ['Rio Branco', 'AC'],
  ['Maceió', 'AL'],
  ['Macapá', 'AP'],
  ['Manaus', 'AM'],
  ['Salvador', 'BA'],
  ['Fortaleza', 'CE'],
  ['Brasília', 'DF'],
  ['Vitória', 'ES'],
  ['Goiânia', 'GO'],
  ['São Luís', 'MA'],
  ['Cuiabá', 'MT'],
  ['Campo Grande', 'MS'],
  ['Belo Horizonte', 'MG'],
  ['Belém', 'PA'],
  ['João Pessoa', 'PB'],
  ['Curitiba', 'PR'],
  ['Recife', 'PE'],
  ['Teresina', 'PI'],
  ['Rio de Janeiro', 'RJ'],
  ['Natal', 'RN'],
  ['Porto Alegre', 'RS'],
  ['Porto Velho', 'RO'],
  ['Boa Vista', 'RR'],
  ['Florianópolis', 'SC'],
  ['São Paulo', 'SP'],
  ['Aracaju', 'SE'],
  ['Palmas', 'TO'],
  ['Guarulhos', 'SP'],
  ['Campinas', 'SP'],
  ['São Bernardo do Campo', 'SP'],
  ['Santo André', 'SP'],
  ['Osasco', 'SP'],
  ['Ribeirão Preto', 'SP'],
  ['Sorocaba', 'SP'],
  ['São José dos Campos', 'SP'],
  ['Mogi das Cruzes', 'SP'],
  ['Jundiaí', 'SP'],
  ['Santos', 'SP'],
  ['Piracicaba', 'SP'],
  ['Bauru', 'SP'],
  ['São José do Rio Preto', 'SP'],
  ['Franca', 'SP'],
  ['Limeira', 'SP'],
  ['Taubaté', 'SP'],
  ['Presidente Prudente', 'SP'],
  ['Araçatuba', 'SP'],
  ['São Gonçalo', 'RJ'],
  ['Duque de Caxias', 'RJ'],
  ['Nova Iguaçu', 'RJ'],
  ['Niterói', 'RJ'],
  ['Campos dos Goytacazes', 'RJ'],
  ['Volta Redonda', 'RJ'],
  ['Petrópolis', 'RJ'],
  ['Macaé', 'RJ'],
  ['Uberlândia', 'MG'],
  ['Contagem', 'MG'],
  ['Juiz de Fora', 'MG'],
  ['Betim', 'MG'],
  ['Montes Claros', 'MG'],
  ['Uberaba', 'MG'],
  ['Governador Valadares', 'MG'],
  ['Ipatinga', 'MG'],
  ['Joinville', 'SC'],
  ['Blumenau', 'SC'],
  ['Chapecó', 'SC'],
  ['Criciúma', 'SC'],
  ['Londrina', 'PR'],
  ['Maringá', 'PR'],
  ['Ponta Grossa', 'PR'],
  ['Cascavel', 'PR'],
  ['Foz do Iguaçu', 'PR'],
  ['Caxias do Sul', 'RS'],
  ['Pelotas', 'RS'],
  ['Canoas', 'RS'],
  ['Santa Maria', 'RS'],
  ['Passo Fundo', 'RS'],
  ['Feira de Santana', 'BA'],
  ['Vitória da Conquista', 'BA'],
  ['Camaçari', 'BA'],
  ['Ilhéus', 'BA'],
  ['Barreiras', 'BA'],
  ['Jaboatão dos Guararapes', 'PE'],
  ['Olinda', 'PE'],
  ['Caruaru', 'PE'],
  ['Petrolina', 'PE'],
  ['Caucaia', 'CE'],
  ['Juazeiro do Norte', 'CE'],
  ['Sobral', 'CE'],
  ['Campina Grande', 'PB'],
  ['Mossoró', 'RN'],
  ['Imperatriz', 'MA'],
  ['Parnaíba', 'PI'],
  ['Arapiraca', 'AL'],
  ['Aparecida de Goiânia', 'GO'],
  ['Anápolis', 'GO'],
  ['Rio Verde', 'GO'],
  ['Serra', 'ES'],
  ['Vila Velha', 'ES'],
  ['Cariacica', 'ES'],
  ['Ananindeua', 'PA'],
  ['Santarém', 'PA'],
  ['Marabá', 'PA'],
  ['Altamira', 'PA'],
  ['Várzea Grande', 'MT'],
  ['Rondonópolis', 'MT'],
  ['Sinop', 'MT'],
  ['Dourados', 'MS'],
  ['Corumbá', 'MS'],
  ['Ji-Paraná', 'RO'],
  ['Araguaína', 'TO'],
  ['Parintins', 'AM'],
  ['Itacoatiara', 'AM'],
]);

const round = (v, d = 0) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

/** Open-Meteo forecast JSON → compact Portuguese payload. */
export function forecastPayload(json, nowMs = Date.now()) {
  const c = json?.current || {};
  const h = json?.hourly || {};
  const d = json?.daily || {};
  const [desc, icon] = weatherText(c.weather_code);
  const horas = [];
  const times = Array.isArray(h.time) ? h.time : [];
  // Open-Meteo times are local wall-clock (timezone=America/Sao_Paulo).
  const nowLocal = new Date(nowMs - 3 * 3_600_000).toISOString().slice(0, 13);
  let start = times.findIndex((t) => t.slice(0, 13) >= nowLocal);
  if (start < 0) start = 0;
  for (let i = start; i < Math.min(times.length, start + 24); i += 1) {
    const [hd, hi] = weatherText(h.weather_code?.[i]);
    horas.push({
      hora: times[i].slice(11, 16),
      temp: round(h.temperature_2m?.[i]),
      chuvaProb: round(h.precipitation_probability?.[i]),
      chuvaMm: round(h.precipitation?.[i], 1),
      desc: hd,
      icone: hi,
    });
  }
  const dias = [];
  for (let i = 0; i < (d.time?.length || 0); i += 1) {
    const [dd, di] = weatherText(d.weather_code?.[i]);
    dias.push({
      dia: d.time[i],
      min: round(d.temperature_2m_min?.[i]),
      max: round(d.temperature_2m_max?.[i]),
      chuvaProb: round(d.precipitation_probability_max?.[i]),
      chuvaMm: round(d.precipitation_sum?.[i], 1),
      desc: dd,
      icone: di,
    });
  }
  return {
    agora: {
      temp: round(c.temperature_2m),
      sensacao: round(c.apparent_temperature),
      umidade: round(c.relative_humidity_2m),
      ventoKmh: round(c.wind_speed_10m),
      rajadaKmh: round(c.wind_gusts_10m),
      chuvaMm: round(c.precipitation, 1),
      desc,
      icone: icon,
    },
    horas,
    dias,
  };
}

export function airPayload(current) {
  if (!current) return null;
  const aqi = round(current.us_aqi);
  const level = aqiLevel(aqi);
  return {
    aqi,
    ...(level || {}),
    pm25: round(current.pm2_5, 1),
    pm10: round(current.pm10, 1),
    o3: round(current.ozone),
    no2: round(current.nitrogen_dioxide, 1),
  };
}

export function createWeatherNow({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const places = new Map();
  let cities = null;
  let citiesPending = null;

  async function getJson(url) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) {
      await res.body?.cancel?.();
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  async function forPlace(lat, lon) {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = places.get(key);
    if (hit && now() - hit.at < PLACE_TTL_MS) return hit.value;
    const f = new URL(FORECAST_URL);
    f.search = new URLSearchParams({
      latitude: lat.toFixed(3),
      longitude: lon.toFixed(3),
      current:
        'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m',
      hourly:
        'temperature_2m,precipitation_probability,precipitation,weather_code',
      daily:
        'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum',
      timezone: 'America/Sao_Paulo',
      forecast_days: '7',
    }).toString();
    const a = new URL(AIR_URL);
    a.search = new URLSearchParams({
      latitude: lat.toFixed(3),
      longitude: lon.toFixed(3),
      current: 'us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide',
      timezone: 'America/Sao_Paulo',
    }).toString();
    const [forecast, air] = await Promise.allSettled([
      getJson(f.href),
      getJson(a.href),
    ]);
    if (forecast.status !== 'fulfilled' && air.status !== 'fulfilled')
      throw new Error('open-meteo indisponível');
    const value = {
      ...(forecast.status === 'fulfilled'
        ? forecastPayload(forecast.value, now())
        : { agora: null, horas: [], dias: [] }),
      ar: air.status === 'fulfilled' ? airPayload(air.value?.current) : null,
      fonte:
        'Open-Meteo (previsão) e Copernicus CAMS (qualidade do ar, estimativa)',
    };
    places.set(key, { at: now(), value });
    while (places.size > 500) places.delete(places.keys().next().value);
    return value;
  }

  async function airCities() {
    if (cities && now() - cities.at < CITIES_TTL_MS) return cities.value;
    if (citiesPending) return citiesPending;
    citiesPending = (async () => {
      const idx = municipios();
      const list = AIR_CITIES.map(([nome, uf]) => idx.find(nome, uf)).filter(
        Boolean,
      );
      const out = [];
      for (let i = 0; i < list.length; i += 50) {
        const batch = list.slice(i, i + 50);
        const a = new URL(AIR_URL);
        a.search = new URLSearchParams({
          latitude: batch.map((m) => m.lat).join(','),
          longitude: batch.map((m) => m.lon).join(','),
          current: 'us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide',
          timezone: 'America/Sao_Paulo',
        }).toString();
        const json = await getJson(a.href);
        const rows = Array.isArray(json) ? json : [json];
        rows.forEach((row, j) => {
          const m = batch[j];
          const air = airPayload(row?.current);
          if (m && air?.aqi != null)
            out.push({
              code: m.code,
              nome: m.nome,
              uf: m.uf,
              lat: m.lat,
              lon: m.lon,
              ...air,
            });
        });
      }
      const value = { cidades: out, atualizado: now() };
      cities = { at: now(), value };
      return value;
    })().finally(() => {
      citiesPending = null;
    });
    return citiesPending;
  }

  return { forPlace, airCities };
}

let shared = null;
export function weatherNow() {
  shared ??= createWeatherNow();
  return shared;
}

export function weatherNowProxy() {
  const send = (res, status, body, cache) => {
    if (res.headersSent) return;
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200 ? cache : 'no-store',
    });
    res.end(JSON.stringify(body));
  };
  const tempo = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180
      )
        return send(res, 400, { error: 'ponto' });
      send(
        res,
        200,
        await weatherNow().forPlace(lat, lon),
        'private, max-age=600',
      );
    } catch (err) {
      console.warn('[tempo]', err?.message || err);
      send(res, 502, { error: 'previsao_indisponivel' });
    }
  };
  const ar = async (_req, res) => {
    try {
      send(res, 200, await weatherNow().airCities(), 'private, max-age=900');
    } catch (err) {
      console.warn('[ar]', err?.message || err);
      send(res, 502, { error: 'ar_indisponivel' });
    }
  };
  const install = (server) => {
    server.middlewares.use('/api/br/tempo', tempo);
    server.middlewares.use('/api/br/ar', ar);
  };
  return {
    name: 'barreto-weather-now',
    configureServer: install,
    configurePreviewServer: install,
  };
}
