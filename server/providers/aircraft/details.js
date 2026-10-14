/**
 * barreto.top: everything public about one aircraft, for the pt-BR detail
 * sheet. GET /api/aircraft/details?hex=e4910c[&callsign=AZU4501]
 *
 * Combines, all cached:
 *  - adsbdb.com: registration, type, owner/operator, owner country (24 h);
 *  - adsbdb.com by callsign: airline and full origin/destination (24 h);
 *  - adsb.lol by hex: live transponder data — squawk, emergency, speeds,
 *    selected altitude, wind/temperature when broadcast (10 s);
 *  - planespotters.net: one photo with photographer credit (24 h).
 * Any source that fails is simply left out.
 */
const DAY_MS = 24 * 3600_000;
const LIVE_MS = 10_000;
const MAX_ENTRIES = 3000;
const UA = 'barreto.top (+https://barreto.top) god-eyes-view';

function boundedCache() {
  const map = new Map();
  return {
    get(key, ttl) {
      const hit = map.get(key);
      return hit && Date.now() - hit.at < ttl ? hit : null;
    },
    set(key, data) {
      map.delete(key);
      map.set(key, { at: Date.now(), data });
      if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
    },
  };
}

const num = (v) =>
  Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null;
const text = (v) => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
  return s || null;
};

export function parseAdsbdbAircraft(json) {
  const a = json?.response?.aircraft;
  if (!a || typeof a !== 'object') return null;
  return {
    registration: text(a.registration),
    type: text(a.type),
    icaoType: text(a.icao_type),
    manufacturer: text(a.manufacturer),
    owner: text(a.registered_owner),
    ownerCountry: text(a.registered_owner_country_name),
    ownerCountryIso: text(a.registered_owner_country_iso_name),
    operatorFlag: text(a.registered_owner_operator_flag_code),
    photo: text(a.url_photo),
    photoThumb: text(a.url_photo_thumbnail),
  };
}

export function parseAdsbdbRoute(json) {
  const fr = json?.response?.flightroute;
  if (!fr || typeof fr !== 'object') return null;
  const airport = (a) =>
    a && typeof a === 'object'
      ? {
          iata: text(a.iata_code),
          icao: text(a.icao_code),
          name: text(a.name),
          city: text(a.municipality),
          country: text(a.country_name),
          countryIso: text(a.country_iso_name),
          elevationFt: num(a.elevation),
          lat: num(a.latitude),
          lon: num(a.longitude),
        }
      : null;
  return {
    callsign: text(fr.callsign),
    callsignIata: text(fr.callsign_iata),
    airline: fr.airline
      ? {
          name: text(fr.airline.name),
          icao: text(fr.airline.icao),
          iata: text(fr.airline.iata),
          country: text(fr.airline.country),
          radioCallsign: text(fr.airline.callsign),
        }
      : null,
    origin: airport(fr.origin),
    destination: airport(fr.destination),
  };
}

/** One readsb aircraft (adsb.lol /v2/hex) → the fields worth showing. */
export function parseReadsbAircraft(ac) {
  if (!ac || typeof ac !== 'object') return null;
  const altBaro = ac.alt_baro === 'ground' ? 0 : num(ac.alt_baro);
  return {
    callsign: text(ac.flight),
    registration: text(ac.r),
    type: text(ac.t),
    description: text(ac.desc),
    operator: text(ac.ownOp),
    year: text(ac.year),
    military: (Number(ac.dbFlags) & 1) === 1,
    onGround: ac.alt_baro === 'ground',
    squawk: text(ac.squawk),
    emergency:
      text(ac.emergency) && ac.emergency !== 'none' ? ac.emergency : null,
    category: text(ac.category),
    altBaroFt: altBaro,
    altGeomFt: num(ac.alt_geom),
    groundSpeedKt: num(ac.gs),
    iasKt: num(ac.ias),
    tasKt: num(ac.tas),
    mach: num(ac.mach),
    trackDeg: num(ac.track),
    headingDeg: num(ac.true_heading ?? ac.mag_heading),
    verticalRateFpm: num(ac.baro_rate ?? ac.geom_rate),
    selectedAltitudeFt: num(ac.nav_altitude_mcp ?? ac.nav_altitude_fms),
    selectedHeadingDeg: num(ac.nav_heading),
    qnhHpa: num(ac.nav_qnh),
    windDirDeg: num(ac.wd),
    windSpeedKt: num(ac.ws),
    outsideTempC: num(ac.oat),
    lat: num(ac.lat),
    lon: num(ac.lon),
    seenSec: num(ac.seen),
    source: text(ac.type),
    messages: num(ac.messages),
  };
}

export function parsePlanespotters(json) {
  const p = Array.isArray(json?.photos) ? json.photos[0] : null;
  if (!p) return null;
  return {
    thumb: text(p.thumbnail_large?.src) || text(p.thumbnail?.src),
    link: text(p.link),
    photographer: text(p.photographer),
  };
}

async function fetchJson(url, fetchImpl, timeoutMs = 8000) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return { missing: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { json: await res.json() };
}

export function aircraftDetailsProxy({ fetchImpl = globalThis.fetch } = {}) {
  const aircraftCache = boundedCache();
  const routeCache = boundedCache();
  const liveCache = boundedCache();
  const photoCache = boundedCache();

  async function cached(cache, key, ttl, load) {
    const hit = cache.get(key, ttl);
    if (hit) return hit.data;
    try {
      const data = await load();
      cache.set(key, data);
      return data;
    } catch {
      return cache.get(key, Infinity)?.data ?? null;
    }
  }

  const loaders = {
    aircraft: (hex) =>
      cached(aircraftCache, hex, DAY_MS, async () => {
        const r = await fetchJson(
          `https://api.adsbdb.com/v0/aircraft/${hex}`,
          fetchImpl,
        );
        return r.missing ? null : parseAdsbdbAircraft(r.json);
      }),
    route: (cs) =>
      cached(routeCache, cs, DAY_MS, async () => {
        const r = await fetchJson(
          `https://api.adsbdb.com/v0/callsign/${cs}`,
          fetchImpl,
        );
        return r.missing ? null : parseAdsbdbRoute(r.json);
      }),
    live: (hex) =>
      cached(liveCache, hex, LIVE_MS, async () => {
        const r = await fetchJson(
          `https://api.adsb.lol/v2/hex/${hex}`,
          fetchImpl,
          6000,
        );
        return r.missing ? null : parseReadsbAircraft(r.json?.ac?.[0]);
      }),
    photo: (hex) =>
      cached(photoCache, hex, DAY_MS, async () => {
        const r = await fetchJson(
          `https://api.planespotters.net/pub/photos/hex/${hex}`,
          fetchImpl,
        );
        return r.missing ? null : parsePlanespotters(r.json);
      }),
  };

  const install = (server) => {
    server.middlewares.use('/api/aircraft/details', async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'GET')
        return send(405, { error: 'method_not_allowed' });
      const url = new URL(req.url || '/', 'http://localhost');
      const hex = String(url.searchParams.get('hex') || '')
        .toLowerCase()
        .replace(/^~/, '');
      if (!/^[0-9a-f]{6}$/.test(hex))
        return send(400, { error: 'invalid_hex' });
      const cs = String(url.searchParams.get('callsign') || '')
        .trim()
        .toUpperCase();
      const [aircraft, live, photo] = await Promise.all([
        loaders.aircraft(hex),
        loaders.live(hex),
        loaders.photo(hex),
      ]);
      const callsign = /^[A-Z0-9]{3,8}$/.test(cs)
        ? cs
        : /^[A-Z0-9]{3,8}$/.test(live?.callsign || '')
          ? live.callsign
          : null;
      const route =
        callsign && /^[A-Z]{3}\d/.test(callsign)
          ? await loaders.route(callsign)
          : null;
      const fallbackPhoto =
        !photo && aircraft?.photoThumb
          ? {
              thumb: aircraft.photoThumb,
              link: aircraft.photo,
              photographer: null,
            }
          : null;
      return send(200, {
        hex,
        callsign,
        aircraft,
        route,
        live,
        photo: photo || fallbackPhoto,
      });
    });
  };
  return {
    name: 'barreto-aircraft-details',
    configureServer: install,
    configurePreviewServer: install,
  };
}
