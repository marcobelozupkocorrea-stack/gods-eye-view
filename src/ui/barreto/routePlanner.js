/**
 * barreto.top: "Rota" — plan a route by typing places (address, CEP, place
 * name, favourites or "minha localização"), with up to 10 stops, a planned
 * departure time, toll avoidance, alternatives, hand-off to Waze / Google
 * Maps, and "No caminho": incidents, warnings, rain, Cemaden alerts and
 * cameras along the way. Drives the existing Directions layer.
 */
import { attachPlaceInput } from './placeInput.js';
import {
  addFavorite,
  cameraView,
  escapeHtml,
  flyToPlace,
  loadFavorites,
  onFavorites,
  removeFavorite,
  reversePlace,
} from './places.js';
import { buildCorridorReport } from './routeCorridor.js';

const MAX_STOPS = 10;
const MODES = [
  ['car', 'Carro', 'directions_car'],
  ['foot', 'A pé', 'directions_walk'],
  ['bike', 'Bicicleta', 'directions_bike'],
];

const fmtKm = (m) =>
  m < 1000
    ? `${Math.round(m / 10) * 10} m`
    : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0).replace('.', ',')} km`;
export function fmtDuration(s) {
  const min = Math.round((s || 0) / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}
const clock = (iso) => {
  const d = new Date(iso || '');
  return Number.isFinite(d.getTime())
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : '';
};
const kmText = (km) =>
  km == null
    ? ''
    : `km ${km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)}`;

/** "2026-10-14T18:00" (local) → "2026-10-14T18:00:00-03:00". */
export function localToIso(value) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value || '')) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  return `${value}:00${sign}${hh}:${mm}`;
}

function navUrl(app, points, mode) {
  const b = points.at(-1);
  if (!b) return null;
  const dest = `${b.lat.toFixed(6)},${b.lon.toFixed(6)}`;
  if (app === 'waze')
    return `https://waze.com/ul?ll=${encodeURIComponent(dest)}&navigate=yes`;
  const travel =
    mode === 'foot' ? 'walking' : mode === 'bike' ? 'bicycling' : 'driving';
  const a = points[0];
  const stops = points.slice(1, -1);
  const way = stops.length
    ? `&waypoints=${encodeURIComponent(stops.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join('|'))}`
    : '';
  return `https://www.google.com/maps/dir/?api=1&origin=${a.lat.toFixed(6)},${a.lon.toFixed(6)}&destination=${dest}${way}&travelmode=${travel}`;
}

const INCIDENT_ICON = {
  accident: '💥',
  roadwork: '🚧',
  closure: '⛔',
  weather: '🌧',
  hazard: '⚠',
};

export function initRoutePlanner({ styleManager, dataManager, signal } = {}) {
  const viewer = () => styleManager?.viewer || null;
  const panel = document.createElement('aside');
  panel.id = 'barreto-route';
  panel.className = 'barreto-route';
  panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'barreto-route-title');
  panel.innerHTML = `
    <header class="barreto-route-header">
      <span class="material-symbols-outlined" aria-hidden="true">directions</span>
      <h2 id="barreto-route-title">Rota</h2>
      <button type="button" class="barreto-route-close" aria-label="Fechar rota" title="Fechar (a rota continua no mapa)">
        <span class="material-symbols-outlined" aria-hidden="true">close</span>
      </button>
    </header>
    <div class="barreto-route-body">
      <div class="barreto-route-modes" role="radiogroup" aria-label="Meio de transporte">
        ${MODES.map(
          ([id, label, icon]) =>
            `<button type="button" role="radio" data-mode="${id}" aria-checked="false"><span class="material-symbols-outlined" aria-hidden="true">${icon}</span>${label}</button>`,
        ).join('')}
      </div>
      <div class="barreto-route-fields"></div>
      <div class="barreto-route-row">
        <button type="button" class="barreto-route-add-stop"><span class="material-symbols-outlined" aria-hidden="true">add_location_alt</span>Adicionar parada</button>
        <button type="button" class="barreto-route-swap" title="Inverter origem e destino" aria-label="Inverter origem e destino"><span class="material-symbols-outlined" aria-hidden="true">swap_vert</span></button>
      </div>
      <div class="barreto-route-options">
        <label class="barreto-route-depart">Saída
          <select>
            <option value="now">Agora</option>
            <option value="30">Daqui a 30 min</option>
            <option value="60">Daqui a 1 hora</option>
            <option value="pick">Escolher dia e hora…</option>
          </select>
        </label>
        <input type="datetime-local" class="barreto-route-depart-at" hidden aria-label="Dia e hora da saída" />
        <label class="barreto-route-tolls"><input type="checkbox" /> Sem pedágio</label>
      </div>
      <section class="barreto-route-result" hidden aria-live="polite"></section>
      <section class="barreto-route-report" hidden></section>
      <section class="barreto-route-favs">
        <h3>Meus lugares</h3>
        <div class="barreto-route-fav-list"></div>
        <p class="barreto-route-hint">Salve o destino atual com um nome (ex.: Casa, Trabalho). Seus lugares ficam guardados na sua conta e aparecem no celular e no computador.</p>
        <form class="barreto-route-fav-form">
          <input type="text" maxlength="40" placeholder="Nome (ex.: Casa)" aria-label="Nome do lugar favorito" />
          <button type="submit">Salvar destino</button>
        </form>
      </section>
    </div>`;
  document.body.append(panel);
  const $ = (s) => panel.querySelector(s);
  const fieldsEl = $('.barreto-route-fields');
  const resultEl = $('.barreto-route-result');
  const reportEl = $('.barreto-route-report');

  /** @type {{key:string, role:'origin'|'stop'|'dest', place:object|null, input?:HTMLInputElement, ac?:AbortController}[]} */
  let slots = [
    { key: 'o', role: 'origin', place: null },
    { key: 'd', role: 'dest', place: null },
  ];
  let mode = 'car';
  let depart = null;
  let avoidTolls = false;
  let lastRoute = null;
  let reportController = null;
  let reportKey = '';
  let applying = false;
  /** Frame the next route the planner asks for (not the 5-min refreshes). */
  let flyPending = false;
  let slotSeq = 0;

  const getCenter = () => {
    const v = cameraView(viewer());
    return v && Number.isFinite(v.lat) ? v : null;
  };

  function renderFields() {
    for (const slot of slots) slot.ac?.abort();
    fieldsEl.innerHTML = '';
    slots.forEach((slot, index) => {
      const row = document.createElement('div');
      row.className = `barreto-route-field ${slot.role}`;
      const badge =
        slot.role === 'origin'
          ? 'A'
          : slot.role === 'dest'
            ? 'B'
            : String(index);
      const placeholder =
        slot.role === 'origin'
          ? 'De onde? (endereço, CEP, lugar)'
          : slot.role === 'dest'
            ? 'Para onde?'
            : `Parada ${index}`;
      row.innerHTML = `
        <span class="barreto-route-badge" aria-hidden="true">${badge}</span>
        <div class="barreto-route-input-wrap">
          <input type="text" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(placeholder)}" />
        </div>
        ${slot.role === 'stop' ? `<button type="button" class="barreto-route-remove" title="Remover parada" aria-label="Remover parada ${index}"><span class="material-symbols-outlined" aria-hidden="true">close</span></button>` : ''}`;
      fieldsEl.append(row);
      const input = row.querySelector('input');
      input.value = slot.place?.name || '';
      slot.input = input;
      slot.ac = new AbortController();
      attachPlaceInput({
        input,
        getCenter,
        offerLocation: true,
        signal: slot.ac.signal,
        onPick: (place) => {
          slot.place = place;
          maybeRoute();
        },
      });
      row
        .querySelector('.barreto-route-remove')
        ?.addEventListener('click', () => {
          slots = slots.filter((s) => s !== slot);
          renderFields();
          maybeRoute();
        });
    });
    const stops = slots.filter((s) => s.role === 'stop').length;
    $('.barreto-route-add-stop').disabled = stops >= MAX_STOPS;
    $('.barreto-route-add-stop').title =
      stops >= MAX_STOPS ? `No máximo ${MAX_STOPS} paradas` : '';
  }

  function renderModes() {
    for (const b of panel.querySelectorAll('[data-mode]')) {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }
    $('.barreto-route-options').hidden = mode !== 'car';
  }

  function points() {
    return slots.map((s) => s.place).filter(Boolean);
  }

  async function maybeRoute() {
    const origin = slots[0].place;
    const dest = slots.at(-1).place;
    if (!origin || !dest) {
      resultEl.hidden = false;
      resultEl.innerHTML = `<p class="barreto-route-hint">${!origin ? 'Escolha de onde sai' : 'Escolha para onde vai'} — digite um endereço, CEP ou nome de lugar.</p>`;
      return;
    }
    applying = true;
    flyPending = true;
    try {
      if (!dataManager?.isEnabled?.('directions'))
        await dataManager?.setEnabled?.('directions', true, { origin: 'user' });
      dataManager?.setLayerParams?.(
        'directions',
        {
          mode,
          avoidTolls,
          depart: mode === 'car' ? depart : null,
          points: points().map(({ lat, lon, name }) => ({
            lat,
            lon,
            label: name,
          })),
        },
        { origin: 'user' },
      );
      resultEl.hidden = false;
      resultEl.innerHTML =
        '<p class="barreto-route-hint">Calculando a rota…</p>';
      reportEl.hidden = true;
    } finally {
      applying = false;
    }
  }

  function departIso() {
    const sel = $('.barreto-route-depart select').value;
    if (sel === 'now') return null;
    if (sel === 'pick') return localToIso($('.barreto-route-depart-at').value);
    const d = new Date(Date.now() + Number(sel) * 60_000);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
    return localToIso(local);
  }

  function renderResult(detail) {
    const route = detail?.route;
    if (detail?.status === 'routing') {
      resultEl.hidden = false;
      resultEl.innerHTML =
        '<p class="barreto-route-hint">Calculando a rota…</p>';
      return;
    }
    if (!route) {
      if (detail?.status === 'error') {
        resultEl.hidden = false;
        resultEl.innerHTML =
          '<p class="barreto-route-error">Não foi possível calcular essa rota. Confira os endereços ou tente outro meio de transporte.</p>';
      }
      reportEl.hidden = true;
      return;
    }
    const t = route.traffic || {};
    const alts = detail.routes || [];
    const delay =
      t.delayS >= 60
        ? ` <span class="barreto-route-delay">+${fmtDuration(t.delayS)} de trânsito</span>`
        : '';
    const when = [
      depart && t.departure ? `saída ${clock(t.departure)}` : '',
      t.arrival ? `chegada ${clock(t.arrival)}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const pts = detail.points || [];
    resultEl.hidden = false;
    resultEl.innerHTML = `
      <div class="barreto-route-summary">
        <strong>${fmtDuration(route.durationS)}</strong>${delay}
        <span>${fmtKm(route.distanceM)}${when ? ` · ${when}` : ''}</span>
        <small>${route.provider === 'tomtom' ? 'Com trânsito ao vivo (TomTom)' : mode === 'car' ? 'Sem dados de trânsito (OpenStreetMap)' : 'OpenStreetMap'}</small>
      </div>
      ${
        alts.length > 1
          ? `<div class="barreto-route-alts" role="group" aria-label="Rotas">${alts
              .map(
                (r, i) =>
                  `<button type="button" data-alt="${i}" class="${i === detail.routeIndex ? 'active' : ''}">Rota ${i + 1}<span>${fmtDuration(r.durationS)} · ${fmtKm(r.distanceM)}</span></button>`,
              )
              .join('')}</div>`
          : ''
      }
      <div class="barreto-route-actions">
        <a class="barreto-route-nav" href="${escapeHtml(navUrl('waze', pts, mode))}" target="_blank" rel="noopener noreferrer"><span class="material-symbols-outlined" aria-hidden="true">navigation</span>Abrir no Waze</a>
        <a class="barreto-route-nav" href="${escapeHtml(navUrl('google', pts, mode))}" target="_blank" rel="noopener noreferrer"><span class="material-symbols-outlined" aria-hidden="true">map</span>Google Maps</a>
        <button type="button" class="barreto-route-fly"><span class="material-symbols-outlined" aria-hidden="true">flight</span>Sobrevoar</button>
        <button type="button" class="barreto-route-clear"><span class="material-symbols-outlined" aria-hidden="true">delete</span>Limpar</button>
      </div>`;
  }

  function row(icon, title, sub, place, cls = '') {
    const fly =
      place && Number.isFinite(place.lat)
        ? ` data-lat="${place.lat}" data-lon="${place.lon}"`
        : '';
    return `<li class="${cls}"><button type="button"${fly}><span class="barreto-route-ico" aria-hidden="true">${icon}</span><span><b>${escapeHtml(title)}</b>${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span></button></li>`;
  }

  function renderReport(report) {
    const sections = [];
    const inc = report.incidents || [];
    sections.push(
      `<h4>Ocorrências no trajeto</h4>${
        inc.length
          ? `<ul>${inc
              .map((i) =>
                row(
                  INCIDENT_ICON[i.kind] || '⚠',
                  i.label,
                  [
                    kmText(i.km),
                    i.delayS >= 60 ? `+${fmtDuration(i.delayS)}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  i,
                ),
              )
              .join('')}</ul>`
          : `<p class="barreto-route-ok">${lastRoute?.provider === 'tomtom' ? 'Nenhum acidente, obra ou bloqueio informado.' : 'Ocorrências só aparecem em rotas de carro com trânsito.'}</p>`
      }`,
    );
    const alerts = report.alerts || [];
    sections.push(
      `<h4>Alertas de tempo e Defesa Civil</h4>${
        alerts.length
          ? `<ul>${alerts
              .map((a) =>
                row(
                  `<i style="background:${escapeHtml(a.color)}"></i>`,
                  `${a.source}: ${a.title}${a.severity ? ` (${a.severity})` : ''}`,
                  `${kmText(a.fromKm)}–${kmText(a.toKm).replace('km ', '')}${a.area ? ` · ${a.area.length > 70 ? `${a.area.slice(0, 70)}…` : a.area}` : ''}`,
                  a,
                ),
              )
              .join('')}</ul>`
          : '<p class="barreto-route-ok">Nenhum alerta ativo no caminho.</p>'
      }`,
    );
    const rain = report.rain || [];
    sections.push(
      `<h4>Chuva agora (radar)</h4>${
        rain.length
          ? `<ul>${rain
              .map((r) =>
                row(
                  r.rank >= 3 ? '⛈' : r.rank === 2 ? '🌧' : '🌦',
                  `Chuva ${r.intensity}`,
                  `${kmText(r.fromKm)}–${kmText(r.toKm).replace('km ', '')} · radar ${r.radar}`,
                  r,
                ),
              )
              .join('')}</ul>`
          : `<p class="barreto-route-ok">${report.radarCount ? 'Sem chuva nos radares sobre o caminho.' : 'Nenhum radar cobre este caminho agora.'}</p>`
      }`,
    );
    if ((report.cemaden || []).length)
      sections.push(
        `<h4>Risco de enchente/deslizamento (Cemaden)</h4><ul>${report.cemaden
          .map((c) =>
            row(
              `<i style="background:${escapeHtml(c.color || '#ff9f0a')}"></i>`,
              `${c.title} – ${c.level}`,
              `${kmText(c.km)} · ${c.place}`,
              c,
            ),
          )
          .join('')}</ul>`,
      );
    const cams = report.cameras || [];
    sections.push(
      `<h4>Câmeras no caminho</h4>${
        cams.length
          ? `<ul>${cams
              .map((c) =>
                row(
                  c.video ? '🎥' : '📷',
                  c.name,
                  [kmText(c.km), c.provider].filter(Boolean).join(' · '),
                  c,
                  'cam',
                ),
              )
              .join(
                '',
              )}</ul><p class="barreto-route-hint">Ligue “Câmeras públicas” em CAMADAS e toque no ícone da câmera no mapa para ver a imagem.</p>`
          : '<p class="barreto-route-ok">Nenhuma câmera pública a menos de 400 m do caminho.</p>'
      }`,
    );
    if (report.pending > 0)
      sections.push(
        '<p class="barreto-route-hint">Ainda verificando algumas fontes…</p>',
      );
    if (report.unavailable?.length)
      sections.push(
        `<p class="barreto-route-hint">Fora do ar agora: ${escapeHtml(report.unavailable.join(', '))}.</p>`,
      );
    reportEl.hidden = false;
    reportEl.innerHTML = `<h3>No caminho</h3>${sections.join('')}`;
  }

  async function refreshReport(route) {
    const key = route
      ? `${route.distanceM}|${route.geometry.length}|${route.geometry[0]}|${route.geometry.at(-1)}|${(route.incidents || []).length}`
      : '';
    if (!route) {
      reportController?.abort();
      reportEl.hidden = true;
      reportKey = '';
      return;
    }
    if (key === reportKey) return;
    reportKey = key;
    reportController?.abort();
    const controller = new AbortController();
    reportController = controller;
    reportEl.hidden = false;
    reportEl.innerHTML =
      '<h3>No caminho</h3><p class="barreto-route-hint">Verificando alertas, chuva e câmeras ao longo da rota…</p>';
    try {
      const report = await buildCorridorReport(route, {
        signal: controller.signal,
        onUpdate: (partial) => {
          if (!controller.signal.aborted) renderReport(partial);
        },
      });
      if (!controller.signal.aborted) renderReport(report);
    } catch (error) {
      if (!controller.signal.aborted)
        reportEl.innerHTML =
          '<h3>No caminho</h3><p class="barreto-route-error">Não foi possível verificar o caminho agora.</p>';
    }
  }

  // Keep the fields in step with points set on the map (ORIGEM / DESTINO chips).
  async function syncFromLayer(detail) {
    const pts = detail.points || [];
    if (applying || !pts.length) return;
    const current = points();
    const same =
      pts.length === current.length &&
      pts.every(
        (p, i) =>
          Math.abs(p.lat - current[i].lat) < 1e-6 &&
          Math.abs(p.lon - current[i].lon) < 1e-6,
      );
    if (same) return;
    slots = pts.map((p, i) => ({
      key: `m${++slotSeq}`,
      role: i === 0 ? 'origin' : i === pts.length - 1 ? 'dest' : 'stop',
      place: { lat: p.lat, lon: p.lon, name: p.label || 'Ponto no mapa' },
    }));
    if (detail.mode) mode = detail.mode;
    renderModes();
    renderFields();
    // Name map-picked points ("Ponto no mapa" → "Pinheiros · São Paulo – SP").
    for (const slot of slots) {
      if (slot.place.name !== 'Ponto no mapa') continue;
      try {
        const r = await reversePlace(slot.place.lat, slot.place.lon, 'bairro');
        if (r?.label && slot.input) {
          slot.place.name = r.label;
          slot.input.value = r.label;
        }
      } catch {
        /* keep the generic name */
      }
    }
  }

  globalThis.addEventListener(
    'barreto:route-changed',
    (event) => {
      const detail = event.detail || {};
      lastRoute = detail.route || null;
      renderResult(detail);
      if (flyPending && detail.route?.geometry?.length) {
        flyPending = false;
        const g = detail.route.geometry;
        const lons = g.map((p) => p[0]);
        const lats = g.map((p) => p[1]);
        const pad = 0.15;
        // On a wide screen the panel covers the right side: leave room.
        const wide = !globalThis.matchMedia?.('(max-width: 720px)').matches;
        const [w, e0] = [Math.min(...lons), Math.max(...lons)];
        const e = wide ? e0 + (e0 - w) * 0.7 + 0.01 : e0;
        const [s, n] = [Math.min(...lats), Math.max(...lats)];
        flyToPlace(viewer(), {
          bbox: [
            w - (e - w) * pad - 0.003,
            s - (n - s) * pad - 0.003,
            e + (e - w) * pad + 0.003,
            n + (n - s) * pad + 0.003,
          ],
        });
      }
      void syncFromLayer(detail);
      void refreshReport(detail.route || null);
    },
    { signal },
  );

  // ---- events
  panel.addEventListener(
    'click',
    (event) => {
      const t = event.target;
      const modeBtn = t.closest?.('[data-mode]');
      if (modeBtn) {
        mode = modeBtn.dataset.mode;
        renderModes();
        void maybeRoute();
        return;
      }
      const alt = t.closest?.('[data-alt]');
      if (alt) {
        dataManager?.setLayerParams?.(
          'directions',
          { route: Number(alt.dataset.alt) },
          { origin: 'user' },
        );
        return;
      }
      const flyRow = t.closest?.('[data-lat]');
      if (flyRow) {
        flyToPlace(
          viewer(),
          {
            lat: Number(flyRow.dataset.lat),
            lon: Number(flyRow.dataset.lon),
          },
          { range: flyRow.closest('.cam') ? 600 : 3000 },
        );
        if (globalThis.matchMedia?.('(max-width: 720px)').matches) hide();
        return;
      }
      if (t.closest?.('.barreto-route-fly')) {
        dataManager?.setLayerParams?.(
          'directions',
          { fly: true },
          { origin: 'user' },
        );
        if (globalThis.matchMedia?.('(max-width: 720px)').matches) hide();
        return;
      }
      if (t.closest?.('.barreto-route-clear')) {
        dataManager?.setLayerParams?.(
          'directions',
          { clear: true },
          { origin: 'user' },
        );
        slots = [
          { key: 'o', role: 'origin', place: null },
          { key: 'd', role: 'dest', place: null },
        ];
        renderFields();
        resultEl.hidden = true;
        reportEl.hidden = true;
        return;
      }
      const favBtn = t.closest?.('[data-fav]');
      if (favBtn) {
        const fav = favorites.find((f) => f.name === favBtn.dataset.fav);
        if (!fav) return;
        if (favBtn.dataset.role === 'remove') void removeFavorite(fav.name);
        else setDestination({ ...fav });
      }
    },
    { signal },
  );
  $('.barreto-route-add-stop').addEventListener(
    'click',
    () => {
      const stops = slots.filter((s) => s.role === 'stop').length;
      if (stops >= MAX_STOPS) return;
      slots.splice(slots.length - 1, 0, {
        key: `s${++slotSeq}`,
        role: 'stop',
        place: null,
      });
      renderFields();
      slots[slots.length - 2].input?.focus();
    },
    { signal },
  );
  $('.barreto-route-swap').addEventListener(
    'click',
    () => {
      const places = slots.map((s) => s.place).reverse();
      slots.forEach((s, i) => (s.place = places[i]));
      renderFields();
      void maybeRoute();
    },
    { signal },
  );
  $('.barreto-route-depart select').addEventListener(
    'change',
    (event) => {
      const pick = event.target.value === 'pick';
      const at = $('.barreto-route-depart-at');
      at.hidden = !pick;
      if (pick) {
        const d = new Date(Date.now() + 60 * 60_000);
        at.min = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000)
          .toISOString()
          .slice(0, 16);
        if (!at.value)
          at.value = new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
            .toISOString()
            .slice(0, 16);
        at.focus();
      }
      depart = departIso();
      void maybeRoute();
    },
    { signal },
  );
  $('.barreto-route-depart-at').addEventListener(
    'change',
    () => {
      depart = departIso();
      void maybeRoute();
    },
    { signal },
  );
  $('.barreto-route-tolls input').addEventListener(
    'change',
    (event) => {
      avoidTolls = event.target.checked;
      void maybeRoute();
    },
    { signal },
  );
  $('.barreto-route-fav-form').addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      const input = event.target.querySelector('input');
      const dest = slots.at(-1).place;
      const name = input.value.trim();
      if (!dest) {
        input.placeholder = 'Escolha um destino primeiro';
        return;
      }
      if (!name) {
        input.focus();
        return;
      }
      void addFavorite(dest, name);
      input.value = '';
    },
    { signal },
  );
  $('.barreto-route-close').addEventListener('click', () => hide(), { signal });
  panel.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) hide();
    },
    { signal },
  );

  // ---- favourites list
  let favorites = [];
  const unsubscribe = onFavorites((list) => {
    favorites = list || [];
    $('.barreto-route-fav-list').innerHTML = favorites.length
      ? favorites
          .map(
            (f) =>
              `<span class="barreto-route-fav"><button type="button" data-fav="${escapeHtml(f.name)}" title="Rota até ${escapeHtml(f.name)}"><span class="material-symbols-outlined" aria-hidden="true">${/casa/i.test(f.name) ? 'home' : /trabalho|escrit/i.test(f.name) ? 'work' : 'star'}</span>${escapeHtml(f.name)}</button><button type="button" data-fav="${escapeHtml(f.name)}" data-role="remove" aria-label="Apagar ${escapeHtml(f.name)}" title="Apagar"><span class="material-symbols-outlined" aria-hidden="true">close</span></button></span>`,
          )
          .join('')
      : '<p class="barreto-route-hint">Nenhum lugar salvo ainda.</p>';
  });
  signal?.addEventListener('abort', unsubscribe);

  // ---- open / close
  function show() {
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add('visible'));
    void loadFavorites();
    document.body.classList.add('barreto-route-open');
  }
  function hide() {
    panel.classList.remove('visible');
    panel.hidden = true;
    document.body.classList.remove('barreto-route-open');
  }
  function setDestination(place) {
    show();
    slots.at(-1).place = place;
    renderFields();
    if (!slots[0].place) {
      slots[0].input?.focus();
      void maybeRoute();
    } else void maybeRoute();
  }

  globalThis.addEventListener(
    'barreto:route-to',
    (event) => {
      if (event.detail?.place) setDestination(event.detail.place);
      else show();
    },
    { signal },
  );

  renderModes();
  renderFields();
  signal?.addEventListener('abort', () => {
    reportController?.abort();
    panel.remove();
  });
  return {
    show,
    hide,
    toggle: () => (panel.hidden ? show() : hide()),
    setDestination,
  };
}
