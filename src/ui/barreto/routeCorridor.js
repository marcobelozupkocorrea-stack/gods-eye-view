/**
 * barreto.top: "O que tem no caminho" — crosses a route with what the map
 * already knows: TomTom incidents, INMET / Defesa Civil warnings, Cemaden
 * risk alerts, rain on the CPTEC radars and public cameras. Pure helpers plus
 * one async builder that fetches the same-origin feeds.
 */

const R = 6371_000;
const rad = (d) => (d * Math.PI) / 180;

export function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Points every `stepM` metres along a [lon, lat] line, with km from start. */
export function routeSamples(geometry, stepM = 400) {
  const out = [];
  if (!Array.isArray(geometry) || geometry.length < 2) return out;
  let along = 0;
  let nextAt = 0;
  for (let i = 1; i < geometry.length; i += 1) {
    const a = { lon: geometry[i - 1][0], lat: geometry[i - 1][1] };
    const b = { lon: geometry[i][0], lat: geometry[i][1] };
    const seg = distanceM(a, b);
    while (seg > 0 && nextAt <= along + seg) {
      const t = (nextAt - along) / seg;
      out.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lon: a.lon + (b.lon - a.lon) * t,
        km: nextAt / 1000,
      });
      nextAt += stepM;
    }
    along += seg;
  }
  const [lon, lat] = geometry[geometry.length - 1];
  out.push({ lat, lon, km: along / 1000 });
  return out;
}

export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi
    )
      inside = !inside;
  }
  return inside;
}

/** `polygons`: [[outerRing, ...holes], ...] of [lon, lat]. */
export function pointInPolygons(lon, lat, polygons) {
  if (!Array.isArray(polygons)) return false;
  for (const poly of polygons) {
    if (!Array.isArray(poly) || !Array.isArray(poly[0])) continue;
    if (!pointInRing(lon, lat, poly[0])) continue;
    let hole = false;
    for (let h = 1; h < poly.length; h += 1)
      if (pointInRing(lon, lat, poly[h])) hole = true;
    if (!hole) return true;
  }
  return false;
}

function bboxOfPolygons(polygons) {
  let w = 180;
  let s = 90;
  let e = -180;
  let n = -90;
  for (const poly of polygons || [])
    for (const [lon, lat] of poly?.[0] || []) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  return [w, s, e, n];
}

/** Contiguous stretches of samples for which `test(sample)` holds. */
export function stretches(samples, test) {
  const out = [];
  let cur = null;
  for (const sample of samples) {
    const value = test(sample);
    if (value) {
      if (!cur) cur = { fromKm: sample.km, toKm: sample.km, at: sample, value };
      else {
        cur.toKm = sample.km;
        if ((value.rank ?? 0) > (cur.value.rank ?? 0)) cur.value = value;
      }
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Warning polygons (INMET, Defesa Civil) the route passes through. */
export function alertsAlongRoute(samples, rows, sourceLabel) {
  const out = [];
  for (const row of rows || []) {
    if (!Array.isArray(row?.polygons) || !row.polygons.length) continue;
    const [w, s, e, n] = bboxOfPolygons(row.polygons);
    const parts = stretches(samples, (p) =>
      p.lon >= w &&
      p.lon <= e &&
      p.lat >= s &&
      p.lat <= n &&
      pointInPolygons(p.lon, p.lat, row.polygons)
        ? { rank: row.severityRank ?? 0 }
        : null,
    );
    if (!parts.length) continue;
    const first = parts[0];
    out.push({
      source: sourceLabel,
      title: row.event || row.headline || 'Alerta',
      severity: row.severityLabel || '',
      rank: row.severityRank ?? 0,
      color: row.color || '#ff9800',
      fromKm: first.fromKm,
      toKm: parts[parts.length - 1].toKm,
      lat: first.at.lat,
      lon: first.at.lon,
      area: row.areaDesc || row.states || '',
    });
  }
  return out.sort((a, b) => a.fromKm - b.fromKm);
}

/** Points (cameras, Cemaden alerts) within `maxM` of the route. */
export function pointsNearRoute(samples, points, maxM) {
  if (!samples.length) return [];
  let w = 180;
  let s = 90;
  let e = -180;
  let n = -90;
  for (const p of samples) {
    if (p.lon < w) w = p.lon;
    if (p.lon > e) e = p.lon;
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
  }
  const pad = maxM / 100_000 + 0.01;
  const out = [];
  for (const pt of points || []) {
    const lat = Number(pt?.lat);
    const lon = Number(pt?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lon < w - pad || lon > e + pad || lat < s - pad || lat > n + pad)
      continue;
    let best = Infinity;
    let km = 0;
    for (const p of samples) {
      const d = distanceM(p, { lat, lon });
      if (d < best) {
        best = d;
        km = p.km;
      }
    }
    if (best <= maxM) out.push({ ...pt, km, offRouteM: Math.round(best) });
  }
  return out.sort((a, b) => a.km - b.km);
}

/** Rain strength from a CPTEC reflectivity pixel (blue/green weak → red strong). */
export function rainFromPixel(r, g, b, a) {
  if (a < 60) return null;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 25) return null; // grey/white: not an echo
  let hue;
  if (max === r) hue = ((g - b) / (max - min)) * 60;
  else if (max === g) hue = (2 + (b - r) / (max - min)) * 60;
  else hue = (4 + (r - g) / (max - min)) * 60;
  if (hue < 0) hue += 360;
  if (hue >= 260 || hue < 20) return { rank: 3, label: 'forte' };
  if (hue < 70) return { rank: 2, label: 'moderada' };
  return { rank: 1, label: 'fraca' };
}

/** Rain stretches from radar frames (`sample(lat, lon)` reads one pixel). */
export function rainAlongRoute(samples, frames) {
  const parts = stretches(samples, (p) => {
    let best = null;
    for (const f of frames) {
      const { west, south, east, north } = f.bounds;
      if (p.lon < west || p.lon > east || p.lat < south || p.lat > north)
        continue;
      const v = f.sample(p.lat, p.lon);
      if (v && (!best || v.rank > best.rank)) best = { ...v, radar: f.name };
    }
    return best;
  });
  return parts.map((s) => ({
    fromKm: s.fromKm,
    toKm: s.toKm,
    intensity: s.value.label,
    rank: s.value.rank,
    radar: s.value.radar,
    lat: s.at.lat,
    lon: s.at.lon,
  }));
}

async function loadFrame(radar, signal) {
  const url = `/api/brazil-radar/frame?id=${encodeURIComponent(radar.id)}&stamp=${radar.stamp}`;
  const res = await fetch(url, { signal, credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const { data, width, height } = ctx.getImageData(
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const { west, south, east, north } = radar.bounds;
  return {
    name: radar.name,
    bounds: radar.bounds,
    sample(lat, lon) {
      // Check a 3×3 neighbourhood: a thin route should not miss a cell.
      const cx = Math.floor(((lon - west) / (east - west)) * width);
      const cy = Math.floor(((north - lat) / (north - south)) * height);
      let best = null;
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const i = (y * width + x) * 4;
          const v = rainFromPixel(
            data[i],
            data[i + 1],
            data[i + 2],
            data[i + 3],
          );
          if (v && (!best || v.rank > best.rank)) best = v;
        }
      return best;
    },
  };
}

const memo = new Map();
async function cachedJson(url, ttlMs, signal, timeoutMs = 15_000) {
  const hit = memo.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const timeout = AbortSignal.timeout?.(timeoutMs);
  const res = await fetch(url, {
    signal:
      signal && timeout && AbortSignal.any
        ? AbortSignal.any([signal, timeout])
        : signal,
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const value = await res.json();
  memo.set(url, { at: Date.now(), value });
  return value;
}

const inBrazil = (p) =>
  p.lat > -34 && p.lat < 6 && p.lon > -74.5 && p.lon < -34;

/**
 * Everything worth knowing along a route. Each part is fetched on its own;
 * one failing source leaves its section marked unavailable.
 */
export async function buildCorridorReport(
  route,
  { signal, onUpdate = () => {}, timeoutMs = 15_000 } = {},
) {
  const samples = routeSamples(route?.geometry || []);
  const report = {
    lengthKm: samples.at(-1)?.km || 0,
    incidents: (route?.incidents || []).map((i) => ({
      ...i,
      km:
        Number.isInteger(i.pointIndex) && route.geometry[i.pointIndex]
          ? (pointsNearRoute(samples, [i], 2000)[0]?.km ?? null)
          : null,
    })),
    alerts: [],
    cemaden: [],
    rain: [],
    cameras: [],
    unavailable: [],
  };
  if (!samples.length) return report;
  const brazil = samples.some(inBrazil);
  const tasks = [];
  if (brazil) {
    tasks.push(
      (async () => {
        const [inmet, defesa] = await Promise.allSettled([
          cachedJson('/api/inmet/alerts', 120_000, signal),
          cachedJson('/api/defesacivil/alerts', 120_000, signal),
        ]);
        if (inmet.status === 'fulfilled')
          report.alerts.push(
            ...alertsAlongRoute(samples, inmet.value?.rows, 'INMET'),
          );
        else report.unavailable.push('INMET');
        if (defesa.status === 'fulfilled')
          report.alerts.push(
            ...alertsAlongRoute(samples, defesa.value?.rows, 'Defesa Civil'),
          );
        else report.unavailable.push('Defesa Civil');
        report.alerts.sort((a, b) => a.fromKm - b.fromKm);
      })(),
      (async () => {
        try {
          const data = await cachedJson('/api/cemaden/alerts', 120_000, signal);
          report.cemaden = pointsNearRoute(samples, data?.rows, 5000).map(
            (r) => ({
              title: r.event,
              level: r.level,
              color: r.color,
              place: [r.municipality, r.uf].filter(Boolean).join(' – '),
              km: r.km,
              lat: r.lat,
              lon: r.lon,
            }),
          );
        } catch {
          report.unavailable.push('Cemaden');
        }
      })(),
      (async () => {
        try {
          const manifest = await cachedJson(
            '/api/brazil-radar/manifest',
            120_000,
            signal,
          );
          const [w, s, e, n] = [
            Math.min(...samples.map((p) => p.lon)),
            Math.min(...samples.map((p) => p.lat)),
            Math.max(...samples.map((p) => p.lon)),
            Math.max(...samples.map((p) => p.lat)),
          ];
          const radars = (manifest?.radars || []).filter(
            (r) =>
              r.bounds.west < e &&
              r.bounds.east > w &&
              r.bounds.south < n &&
              r.bounds.north > s,
          );
          const frames = (
            await Promise.allSettled(radars.map((r) => loadFrame(r, signal)))
          )
            .filter((x) => x.status === 'fulfilled')
            .map((x) => x.value);
          report.radarCount = frames.length;
          report.rain = rainAlongRoute(samples, frames);
        } catch {
          report.unavailable.push('radar');
        }
      })(),
    );
  }
  tasks.push(
    (async () => {
      try {
        const data = await cachedJson('/api/cctv/sources', 600_000, signal);
        report.cameras = pointsNearRoute(samples, data?.sources, 400)
          .slice(0, 40)
          .map((c) => ({
            id: c.id,
            name: c.name,
            provider: c.provider,
            km: c.km,
            lat: c.lat,
            lon: c.lon,
            video: c.feedType === 'video' || c.feedType === 'hls',
          }));
      } catch {
        report.unavailable.push('câmeras');
      }
    })(),
  );
  report.pending = tasks.length;
  await Promise.all(
    tasks.map((task) =>
      task.finally(() => {
        report.pending -= 1;
        if (!signal?.aborted) onUpdate(report);
      }),
    ),
  );
  signal?.throwIfAborted();
  return report;
}
