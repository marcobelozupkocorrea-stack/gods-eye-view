/**
 * barreto.top: "Resumo da manhã" — one notification with, for each of the
 * person's areas / places: today's forecast, active alerts and (for areas)
 * traffic incidents.
 */
import { alertsNear, LEVELS } from './unify.js';

/** Box around a centre for a radius in km. */
export function bboxAround(lat, lon, radiusKm) {
  const dLat = radiusKm / 111;
  const dLon =
    radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((v) =>
    Number(v.toFixed(4)),
  );
}

/** Places for the summary: areas first, then favourites, then location. */
export function summaryPlaces(
  { prefs = {}, favorites = [], areas = [] },
  max = 4,
) {
  const out = [];
  for (const a of areas)
    out.push({
      name: a.nome,
      lat: a.lat,
      lon: a.lon,
      raioKm: a.raioKm,
      area: true,
    });
  for (const f of favorites)
    out.push({ name: f.name, lat: f.lat, lon: f.lon, raioKm: 0 });
  if (prefs.usarLocal && prefs.local)
    out.push({
      name: 'Onde você está',
      lat: prefs.local.lat,
      lon: prefs.local.lon,
      raioKm: 0,
    });
  return out.slice(0, max);
}

/** One line per place. */
export function summaryLine(
  place,
  { riscos = [], weather = null, incidents = null },
) {
  const parts = [];
  const today = weather?.dias?.[0];
  if (today) {
    let t = `${today.min}–${today.max}°, ${String(today.desc || '').toLowerCase()}`;
    const rainHour = (weather.horas || []).find(
      (h) => (h.chuvaProb ?? 0) >= 60 && h.hora >= '06:00',
    );
    if (rainHour)
      t += `, chuva ${rainHour.chuvaProb}% a partir das ${rainHour.hora.slice(0, 2)}h`;
    else if ((today.chuvaProb ?? 0) >= 50) t += `, chuva ${today.chuvaProb}%`;
    parts.push(t);
  }
  const serious = riscos.filter((r) => r.rank >= 1).slice(0, 2);
  if (serious.length)
    parts.push(
      `alerta: ${serious.map((r) => `${r.label.toLowerCase()} (${LEVELS[r.rank].toLowerCase()})`).join(', ')}`,
    );
  if (incidents && incidents.total > 0) {
    const crashes = incidents.items.filter((i) => i.kind === 'acidente').length;
    const closed = incidents.items.filter((i) => i.kind === 'bloqueio').length;
    const detail = [
      crashes ? `${crashes} acidente${crashes > 1 ? 's' : ''}` : '',
      closed ? `${closed} interdiç${closed > 1 ? 'ões' : 'ão'}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    parts.push(
      `${incidents.total} ocorrência${incidents.total > 1 ? 's' : ''} no trânsito${detail ? ` (${detail})` : ''}`,
    );
  }
  return parts.length ? `${place.name}: ${parts.join(' · ')}` : null;
}

/**
 * Build the notification, or null when there is nothing to say.
 * @param {{prefs:object, favorites:object[], areas:object[]}} who
 * @param {{alerts:object[], index:object, weather?:{forPlace:Function}, incidents?:{inBox:Function}}} deps
 */
export async function composeSummary(
  who,
  { alerts = [], index, weather = null, incidents = null },
) {
  const places = summaryPlaces(who);
  if (!places.length) return null;
  const lines = [];
  let maxRank = 0;
  for (const place of places) {
    const near = alertsNear(
      alerts,
      place.lat,
      place.lon,
      index,
      place.raioKm || 0,
    );
    for (const r of near.riscos) maxRank = Math.max(maxRank, r.rank);
    const w = weather
      ? await weather.forPlace(place.lat, place.lon).catch(() => null)
      : null;
    let inc = null;
    if (place.area && incidents) {
      const result = await incidents
        .inBox(bboxAround(place.lat, place.lon, place.raioKm || 5))
        .catch(() => null);
      if (result && !result.semChave && !result.tooWide)
        inc = { total: result.items.length, items: result.items };
    }
    const line = summaryLine(place, {
      riscos: near.riscos,
      weather: w,
      incidents: inc,
    });
    if (line) lines.push(line);
  }
  if (!lines.length) return null;
  return {
    title:
      maxRank >= 3
        ? 'Bom dia · atenção: alerta extremo hoje'
        : 'Bom dia! Seu resumo de hoje',
    body: lines.join('\n'),
    tag: 'resumo',
    rank: maxRank,
    url: '/?origem=resumo&abrir=alertas',
  };
}
