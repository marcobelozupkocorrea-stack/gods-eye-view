/**
 * barreto.top: the extra blocks of the "Perto de você" card — traffic
 * incidents and public cameras around the chosen point, and today's summary
 * (the same text as the morning notification, read in the app).
 */
import { openCameraNear, showIncidentAt } from './cityNow.js';

const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
};
const icon = (name, cls = '') =>
  el('span', {
    className: `material-symbols-outlined${cls ? ` ${cls}` : ''}`,
    'aria-hidden': 'true',
    text: name,
  });

/** Great-circle distance in km. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) *
      Math.cos(lat2 * r) *
      Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Box (w,s,e,n) around a point for a radius in km. */
export function boxAround(lat, lon, km) {
  const dLat = km / 111;
  const dLon = km / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((v) =>
    Number(v.toFixed(4)),
  );
}

export const INCIDENT_ICON = Object.freeze({
  acidente: 'car_crash',
  bloqueio: 'block',
  obra: 'construction',
  faixa: 'traffic',
  quebrado: 'car_repair',
  alagamento: 'flood',
  neblina: 'foggy',
});

/** Incidents worth listing first: real delay, then accidents, then recent. */
export function rankIncidents(items, lat, lon) {
  const weight = (i) =>
    (i.kind === 'acidente' ? 30 : 0) +
    (i.magnitude || 0) * 10 +
    Math.min(20, (i.delayS || 0) / 60) -
    distanceKm(lat, lon, i.lat, i.lon);
  return [...items].sort((a, b) => weight(b) - weight(a));
}

export function incidentSummary(items) {
  const by = {};
  for (const i of items) by[i.label] = (by[i.label] || 0) + 1;
  return Object.entries(by)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([label, n]) => `${label}: ${n}`)
    .join(' · ');
}

let camerasCache = null;
async function cameraSources(signal) {
  if (camerasCache && Date.now() - camerasCache.at < 10 * 60_000)
    return camerasCache.list;
  const res = await fetch('/api/cctv/sources', {
    credentials: 'same-origin',
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body?.sources) ? body.sources : [];
  camerasCache = { at: Date.now(), list };
  return list;
}

/** Cameras within `km`, nearest first. */
export function camerasNear(list, lat, lon, km, max = 6) {
  return list
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .map((c) => ({ ...c, km: distanceKm(lat, lon, c.lat, c.lon) }))
    .filter((c) => c.km <= km)
    .sort((a, b) => a.km - b.km)
    .slice(0, max);
}

const kmText = (km) =>
  km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 1 : 0)} km`;

async function renderIncidents(box, point, km, signal) {
  try {
    const res = await fetch(
      `/api/br/ocorrencias?bbox=${boxAround(point.lat, point.lon, km).join(',')}`,
      { credentials: 'same-origin', signal },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.semChave) return box.remove();
    const items = (body.items || []).filter(
      (i) => distanceKm(point.lat, point.lon, i.lat, i.lon) <= km,
    );
    if (!items.length) {
      box.replaceChildren(
        el('h4', { text: 'Trânsito' }),
        el('p', { className: 'al-ok' }, [
          icon('check_circle'),
          el('span', { text: `Nenhuma ocorrência a até ${km} km.` }),
        ]),
      );
      return;
    }
    const top = rankIncidents(items, point.lat, point.lon).slice(0, 4);
    box.replaceChildren(
      el('h4', {
        text: `Trânsito · ${items.length} ocorrência${items.length > 1 ? 's' : ''} a até ${km} km`,
      }),
      el('p', { className: 'al-muted al-small', text: incidentSummary(items) }),
      el(
        'ul',
        { className: 'al-near-list' },
        top.map((i) => {
          const b = el('button', { type: 'button' }, [
            icon(INCIDENT_ICON[i.kind] || 'warning'),
            el('span', {}, [
              el('b', { text: i.description || i.label }),
              el('small', {
                text: [
                  i.from || i.roads?.[0] || '',
                  i.delayS ? `+${Math.round(i.delayS / 60)} min` : i.delayLabel,
                  kmText(distanceKm(point.lat, point.lon, i.lat, i.lon)),
                ]
                  .filter(Boolean)
                  .join(' · '),
              }),
            ]),
          ]);
          b.addEventListener('click', () => {
            box.dispatchEvent(
              new CustomEvent('barreto:near-go', { bubbles: true }),
            );
            void showIncidentAt(i);
          });
          return el('li', {}, [b]);
        }),
      ),
    );
  } catch {
    if (!signal?.aborted) box.remove();
  }
}

async function renderCameras(box, point, km, signal) {
  try {
    const near = camerasNear(
      await cameraSources(signal),
      point.lat,
      point.lon,
      km,
    );
    if (!near.length) return box.remove();
    const tick = Math.floor(Date.now() / 60_000);
    box.replaceChildren(
      el('h4', { text: `Câmeras a até ${km} km` }),
      el(
        'div',
        { className: 'al-cams' },
        near.map((c) => {
          const video = /hls|video|mjpeg/i.test(String(c.feedType || ''));
          const b = el(
            'button',
            { type: 'button', className: 'al-cam', title: c.name },
            [
              video
                ? el('span', { className: 'al-cam-video' }, [icon('videocam')])
                : el('img', {
                    src: `/api/cctv/frame/${encodeURIComponent(c.id)}?ts=${tick}`,
                    alt: '',
                    loading: 'lazy',
                  }),
              el('span', { className: 'al-cam-name', text: c.name }),
              el('small', {
                text: [kmText(c.km), video ? 'vídeo' : c.provider]
                  .filter(Boolean)
                  .join(' · '),
              }),
            ],
          );
          b.addEventListener('click', () => {
            box.dispatchEvent(
              new CustomEvent('barreto:near-go', { bubbles: true }),
            );
            void openCameraNear(c);
          });
          return b;
        }),
      ),
    );
  } catch {
    if (!signal?.aborted) box.remove();
  }
}

let summaryCache = null;
function renderSummary(box, signal) {
  const details = el('details', { className: 'al-summary' }, [
    el('summary', {}, [
      icon('wb_sunny'),
      el('span', { text: 'Resumo de hoje' }),
    ]),
    el('div', { className: 'al-summary-body' }, [
      el('p', { className: 'al-muted', text: 'Carregando…' }),
    ]),
  ]);
  const body = details.querySelector('.al-summary-body');
  details.addEventListener('toggle', async () => {
    if (!details.open) return;
    try {
      if (!summaryCache || Date.now() - summaryCache.at > 15 * 60_000) {
        const res = await fetch('/api/br/push/resumo', {
          credentials: 'same-origin',
          signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        summaryCache = { at: Date.now(), data: (await res.json())?.resumo };
      }
      const r = summaryCache.data;
      if (!r) {
        body.replaceChildren(
          el('p', {
            className: 'al-muted',
            text: 'Crie uma área de interesse ou salve um lugar para ter o resumo do dia.',
          }),
        );
        return;
      }
      body.replaceChildren(
        el('p', { className: 'al-summary-title', text: r.titulo }),
        el(
          'ul',
          {},
          r.linhas.map((line) => {
            const [name, ...rest] = line.split(': ');
            return el('li', {}, [
              el('b', { text: rest.length ? `${name}: ` : '' }),
              el('span', { text: rest.length ? rest.join(': ') : line }),
            ]);
          }),
        ),
        el('p', {
          className: 'al-muted al-small',
          text: 'Para receber toda manhã: sino → "Resumo da manhã".',
        }),
      );
    } catch {
      if (!signal?.aborted)
        body.replaceChildren(
          el('p', {
            className: 'al-muted',
            text: 'Resumo indisponível agora.',
          }),
        );
    }
  });
  box.replaceChildren(details);
}

/**
 * Fill `container` for a point. `radiusKm` is the area radius (0 = a city
 * point: incidents within 3 km, cameras within 5 km).
 */
export function renderNearExtras(container, point, radiusKm, { signal } = {}) {
  const incidents = el('div', { className: 'al-near-block' }, [
    el('p', {
      className: 'al-muted al-small',
      text: 'Buscando ocorrências de trânsito…',
    }),
  ]);
  const cameras = el('div', { className: 'al-near-block' });
  const summary = el('div', { className: 'al-near-block' });
  container.replaceChildren(summary, incidents, cameras);
  renderSummary(summary, signal);
  void renderIncidents(incidents, point, radiusKm || 3, signal);
  void renderCameras(cameras, point, Math.max(5, radiusKm || 0), signal);
}
