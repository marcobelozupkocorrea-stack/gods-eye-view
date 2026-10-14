/**
 * barreto.top: car routes with live traffic from the TomTom Routing API.
 *
 * Used by /api/route for profile=car when TOMTOM_API_KEY is set. The answer has
 * the same shape as the OSRM one (ok, distanceM, durationS, geometry, steps)
 * plus what only a traffic-aware router knows:
 *   traffic     { delayS, noTrafficS, historicS, departure, arrival }
 *   congestion  [{ from, to, category, magnitude, delayS, speedKmh }] — point
 *               index ranges along `geometry` where traffic is slow
 *   alternatives [ same shape, without alternatives ]
 *
 * TomTom grants 20,000 free Routing requests a month; a persistent daily
 * counter (TOMTOM_DAILY_ROUTE_BUDGET, default 600) keeps a 31-day month inside
 * that. Over budget, or on any upstream failure, the caller falls back to OSRM.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readResponseTextCapped } from '../common/http.js';

const BASE = 'https://api.tomtom.com/routing/1/calculateRoute';
const MAX_BYTES = 6 * 1024 * 1024;
const DEFAULT_DAILY_BUDGET = 600;

/** TomTom maneuver → the OSRM-like {type, modifier} the client already knows. */
const MANEUVERS = Object.freeze({
  DEPART: ['depart', null],
  ARRIVE: ['arrive', null],
  ARRIVE_LEFT: ['arrive', 'left'],
  ARRIVE_RIGHT: ['arrive', 'right'],
  STRAIGHT: ['continue', 'straight'],
  KEEP_RIGHT: ['fork', 'slight right'],
  BEAR_RIGHT: ['turn', 'slight right'],
  TURN_RIGHT: ['turn', 'right'],
  SHARP_RIGHT: ['turn', 'sharp right'],
  KEEP_LEFT: ['fork', 'slight left'],
  BEAR_LEFT: ['turn', 'slight left'],
  TURN_LEFT: ['turn', 'left'],
  SHARP_LEFT: ['turn', 'sharp left'],
  MAKE_UTURN: ['turn', 'uturn'],
  ENTER_MOTORWAY: ['on ramp', null],
  ENTER_FREEWAY: ['on ramp', null],
  ENTER_HIGHWAY: ['on ramp', null],
  TAKE_EXIT: ['off ramp', null],
  MOTORWAY_EXIT_LEFT: ['off ramp', 'left'],
  MOTORWAY_EXIT_RIGHT: ['off ramp', 'right'],
  TAKE_FERRY: ['notification', null],
  ROUNDABOUT_CROSS: ['roundabout', 'straight'],
  ROUNDABOUT_RIGHT: ['roundabout', 'right'],
  ROUNDABOUT_LEFT: ['roundabout', 'left'],
  ROUNDABOUT_BACK: ['roundabout', 'uturn'],
  TRY_MAKE_UTURN: ['turn', 'uturn'],
  FOLLOW: ['continue', null],
  SWITCH_PARALLEL_ROAD: ['continue', null],
  SWITCH_MAIN_ROAD: ['continue', null],
  ENTRANCE_RAMP: ['on ramp', null],
  WAYPOINT_LEFT: ['notification', 'left'],
  WAYPOINT_RIGHT: ['notification', 'right'],
  WAYPOINT_REACHED: ['notification', null],
});

/** TPEG-TEC main cause codes TomTom attaches to traffic sections, in pt-BR. */
export const TRAFFIC_CAUSES_PT = Object.freeze({
  1: 'Congestionamento',
  2: 'Acidente',
  3: 'Obras',
  4: 'Faixas estreitadas',
  5: 'Via interditada',
  6: 'Pista escorregadia',
  7: 'Aquaplanagem',
  8: 'Incêndio',
  9: 'Condições perigosas',
  10: 'Objeto na pista',
  11: 'Animais na pista',
  12: 'Pessoas na pista',
  13: 'Veículo quebrado',
  14: 'Veículo na contramão',
  15: 'Resgate em andamento',
  16: 'Restrição de trânsito',
  17: 'Tempo severo',
  18: 'Visibilidade reduzida',
  19: 'Chuva',
  20: 'Pessoas imprudentes',
  21: 'Altura restrita',
  22: 'Restrição de veículos',
  23: 'Carga perigosa',
  24: 'Alerta de segurança',
  25: 'Atraso de veículos',
  26: 'Atraso de veículos',
  27: 'Evento',
  28: 'Fechamento de equipamento',
});

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** Build the TomTom request URL. `points` are [lon, lat] pairs. */
export function tomtomRouteUrl(
  points,
  { key, lang = 'pt-BR', avoidTolls, depart },
) {
  const locations = points
    .map(([lon, lat]) => `${lat.toFixed(6)},${lon.toFixed(6)}`)
    .join(':');
  const q = new URLSearchParams({
    key,
    traffic: 'true',
    travelMode: 'car',
    routeType: 'fastest',
    instructionsType: 'text',
    language: lang,
    maxAlternatives: points.length === 2 ? '2' : '0',
    sectionType: 'traffic',
    routeRepresentation: 'polyline',
    computeTravelTimeFor: 'all',
  });
  if (avoidTolls) q.append('avoid', 'tollRoads');
  if (depart) q.append('departAt', depart);
  return `${BASE}/${locations}/json?${q}`;
}

function projectOne(route) {
  const points = [];
  for (const leg of route?.legs || [])
    for (const p of leg?.points || []) {
      const lat = num(p?.latitude);
      const lon = num(p?.longitude);
      if (lat === null || lon === null) continue;
      points.push([Number(lon.toFixed(6)), Number(lat.toFixed(6))]);
    }
  const summary = route?.summary || {};
  const distanceM = Math.round(num(summary.lengthInMeters) ?? 0);
  const durationS = Math.round(num(summary.travelTimeInSeconds) ?? 0);
  if (points.length < 2 || !distanceM) return null;
  const raw = Array.isArray(route?.guidance?.instructions)
    ? route.guidance.instructions
    : [];
  const steps = [];
  for (let i = 0; i < raw.length && steps.length < 200; i += 1) {
    const ins = raw[i];
    const lat = num(ins?.point?.latitude);
    const lon = num(ins?.point?.longitude);
    if (lat === null || lon === null) continue;
    const next = raw[i + 1];
    const offset = num(ins.routeOffsetInMeters) ?? 0;
    const time = num(ins.travelTimeInSeconds) ?? 0;
    const [type, modifier] = MANEUVERS[ins.maneuver] || ['continue', null];
    const roads = Array.isArray(ins.roadNumbers) ? ins.roadNumbers : [];
    steps.push({
      index: steps.length,
      type,
      modifier,
      exit: Number.isInteger(ins.roundaboutExitNumber)
        ? ins.roundaboutExitNumber
        : null,
      name: typeof ins.street === 'string' ? ins.street : '',
      ref: roads.length ? roads.join(' / ') : null,
      distanceM: next
        ? Math.max(
            0,
            Math.round((num(next.routeOffsetInMeters) ?? offset) - offset),
          )
        : 0,
      durationS: next
        ? Math.max(
            0,
            Math.round((num(next.travelTimeInSeconds) ?? time) - time),
          )
        : 0,
      lon: Number(lon.toFixed(6)),
      lat: Number(lat.toFixed(6)),
      instruction:
        typeof ins.message === 'string' && ins.message.trim()
          ? ins.message.trim()
          : type === 'arrive'
            ? 'Chegada ao destino'
            : 'Siga em frente',
    });
  }
  const congestion = [];
  for (const s of route?.sections || []) {
    if (s?.sectionType !== 'TRAFFIC') continue;
    const from = num(s.startPointIndex);
    const to = num(s.endPointIndex);
    if (from === null || to === null || to <= from || to >= points.length)
      continue;
    const causes = Array.isArray(s.tec?.causes)
      ? s.tec.causes.map((c) => num(c?.mainCauseCode)).filter((c) => c !== null)
      : [];
    congestion.push({
      from,
      to,
      causes,
      category:
        typeof s.simpleCategory === 'string' ? s.simpleCategory : 'OTHER',
      magnitude: num(s.magnitudeOfDelay) ?? 0,
      delayS: Math.round(num(s.delayInSeconds) ?? 0),
      speedKmh: num(s.effectiveSpeedInKmh),
    });
  }
  // Anything on the route that is more than plain slow traffic: an accident,
  // roadworks, a closed road, a broken-down vehicle…
  const incidents = congestion
    .filter(
      (c) =>
        c.category === 'ROAD_WORK' ||
        c.category === 'ROAD_CLOSURE' ||
        c.causes.some((code) => code !== 1),
    )
    .map((c) => {
      const code = c.causes.find((x) => x !== 1) ?? null;
      const [lon, lat] = points[c.from];
      return {
        lat,
        lon,
        pointIndex: c.from,
        kind:
          c.category === 'ROAD_CLOSURE' || code === 5
            ? 'closure'
            : code === 2
              ? 'accident'
              : c.category === 'ROAD_WORK' || code === 3
                ? 'roadwork'
                : code === 17 || code === 19 || code === 6 || code === 7
                  ? 'weather'
                  : 'hazard',
        label:
          (code && TRAFFIC_CAUSES_PT[code]) ||
          (c.category === 'ROAD_CLOSURE'
            ? 'Via interditada'
            : c.category === 'ROAD_WORK'
              ? 'Obras'
              : 'Ocorrência'),
        delayS: c.delayS,
      };
    });
  return {
    ok: true,
    profile: 'car',
    provider: 'tomtom',
    incidents,
    distanceM,
    durationS,
    geometry: points,
    steps,
    traffic: {
      delayS: Math.round(num(summary.trafficDelayInSeconds) ?? 0),
      noTrafficS: num(summary.noTrafficTravelTimeInSeconds),
      historicS: num(summary.historicTrafficTravelTimeInSeconds),
      departure:
        typeof summary.departureTime === 'string'
          ? summary.departureTime
          : null,
      arrival:
        typeof summary.arrivalTime === 'string' ? summary.arrivalTime : null,
    },
    congestion,
  };
}

/** TomTom's "pt-BR" text still uses some European Portuguese words. */
export function brazilianWording(text) {
  return String(text || '')
    .replace(/\brotundas\b/g, 'rotatórias')
    .replace(/\brotunda\b/g, 'rotatória')
    .replace(/\bRotunda\b/g, 'Rotatória')
    .replace(/\bApanhe\b/g, 'Pegue')
    .replace(/\bapanhe\b/g, 'pegue')
    .replace(/\bsaia na (\S+) saída\b/g, 'pegue a $1 saída')
    .replace(/\bPartida d([aoe]s?) /g, 'Saia d$1 ');
}

/** TomTom calculateRoute JSON → the /api/route payload, or null. */
export function projectTomTomRoutes(json) {
  const routes = Array.isArray(json?.routes) ? json.routes : [];
  const [main, ...rest] = routes.map(projectOne);
  if (!main) return null;
  main.alternatives = rest
    .filter(Boolean)
    .slice(0, 2)
    .map((alt) => ({ ...alt, alternatives: undefined }));
  return main;
}

/** Daily request counter persisted next to the traffic tile budget. */
export function createTomTomRouteBudget({
  dir = path.join(process.cwd(), '.gev-cache', 'tomtom'),
  limit = Number.parseInt(process.env.TOMTOM_DAILY_ROUTE_BUDGET || '', 10) ||
    DEFAULT_DAILY_BUDGET,
  today = () => new Date().toISOString().slice(0, 10),
} = {}) {
  const file = path.join(dir, 'route-budget.json');
  let state = null;
  let loaded = null;
  async function load() {
    loaded ??= fsp
      .readFile(file, 'utf8')
      .then((t) => {
        const v = JSON.parse(t);
        if (typeof v?.date === 'string' && Number.isFinite(v.count)) state = v;
      })
      .catch(() => {});
    await loaded;
    if (!state || state.date !== today()) state = { date: today(), count: 0 };
    return state;
  }
  return {
    limit,
    /** Reserve one request; false when today's budget is spent. */
    async take() {
      const s = await load();
      if (s.count >= limit) return false;
      s.count += 1;
      fsp
        .mkdir(dir, { recursive: true })
        .then(() => fsp.writeFile(file, JSON.stringify(s), 'utf8'))
        .catch(() => {});
      return true;
    },
    async status() {
      const s = await load();
      return { date: s.date, count: s.count, limit };
    },
  };
}

/**
 * Fetch one TomTom route. Resolves to the payload, or null (no route, budget
 * spent, upstream failure) so the caller can fall back to OSRM.
 */
export async function fetchTomTomRoute(
  points,
  {
    key,
    lang,
    avoidTolls,
    depart,
    budget,
    fetchImpl = fetch,
    timeoutMs = 12_000,
  },
) {
  if (!key || !(await budget.take())) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(
      tomtomRouteUrl(points, { key, lang, avoidTolls, depart }),
      {
        signal: controller.signal,
        redirect: 'error',
        headers: { Accept: 'application/json' },
      },
    );
    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {
        /* already closed */
      }
      console.warn('[tomtom-route] HTTP', res.status);
      return null;
    }
    const text = await readResponseTextCapped(res, MAX_BYTES);
    const payload = projectTomTomRoutes(JSON.parse(text));
    if (payload && /^pt/i.test(lang || ''))
      for (const option of [payload, ...(payload.alternatives || [])])
        for (const step of option.steps)
          step.instruction = brazilianWording(step.instruction);
    return payload;
  } catch (error) {
    console.warn('[tomtom-route]', error?.message || error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
