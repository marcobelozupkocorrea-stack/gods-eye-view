/**
 * barreto.top: "Detalhes" sheet. When something is selected on the map —
 * aircraft, military aircraft, vessel, satellite, fire, or a Brazilian alert —
 * show everything known about it in Portuguese, grouped and readable, with
 * links to the original sources. Desktop: a panel on the right. Phone: a
 * bottom sheet. The small in-map card keeps working as before.
 */
import * as Cesium from 'cesium';
import {
  aircraftSheet,
  capAlertSheet,
  cemadenSheet,
  deterSheet,
  earthquakeSheet,
  fireSheet,
  satelliteSheet,
  vesselSheet,
} from './detailsModel.js';

const LIVE_REFRESH_MS = 3000;
const REMOTE_REFRESH_MS = 20_000;

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const safeHref = (href) =>
  /^https:\/\//i.test(String(href || '')) ? String(href) : null;

export function renderSheetHtml(s) {
  const sections = s.sections
    .map(
      (sec) => `
      <section class="barreto-details-section">
        <h3>${escapeHtml(sec.title)}</h3>
        <dl>${sec.rows
          .map(
            ([k, v]) =>
              `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`,
          )
          .join('')}</dl>
      </section>`,
    )
    .join('');
  const links = s.links
    .map((l) => {
      const href = safeHref(l.href);
      return href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.label)}<span class="material-symbols-outlined" aria-hidden="true">open_in_new</span></a>`
        : '';
    })
    .join('');
  return `
    ${s.alert ? `<p class="barreto-details-alert" role="alert">${escapeHtml(s.alert)}</p>` : ''}
    ${s.loading ? '<p class="barreto-details-loading">Buscando mais informações…</p>' : ''}
    ${sections || '<p class="barreto-details-loading">Sem detalhes disponíveis.</p>'}
    ${links ? `<nav class="barreto-details-links" aria-label="Ver em outros sites">${links}</nav>` : ''}
    ${s.note ? `<p class="barreto-details-note">${escapeHtml(s.note)}</p>` : ''}`;
}

export function initDetailsSheet({ dataManager, styleManager, signal } = {}) {
  const panel = document.createElement('aside');
  panel.id = 'barreto-details';
  panel.className = 'barreto-details';
  panel.setAttribute('aria-labelledby', 'barreto-details-title');
  panel.hidden = true;
  panel.innerHTML = `
    <header class="barreto-details-header">
      <span class="material-symbols-outlined barreto-details-icon" aria-hidden="true"></span>
      <div class="barreto-details-heading">
        <span class="barreto-details-kicker"></span>
        <h2 id="barreto-details-title"></h2>
        <p class="barreto-details-subtitle"></p>
      </div>
      <button type="button" class="barreto-details-close" aria-label="Fechar detalhes" title="Fechar detalhes">
        <span class="material-symbols-outlined" aria-hidden="true">close</span>
      </button>
    </header>
    <figure class="barreto-details-photo" hidden>
      <a target="_blank" rel="noopener noreferrer"><img alt="" loading="lazy" referrerpolicy="no-referrer" /></a>
      <figcaption></figcaption>
    </figure>
    <div class="barreto-details-body"></div>`;
  document.body.append(panel);
  const $ = (sel) => panel.querySelector(sel);
  const body = $('.barreto-details-body');
  const photo = $('.barreto-details-photo');

  /** @type {{layerId:string, id:string, build:()=>object, remote?:()=>Promise<void>}|null} */
  let current = null;
  let liveTimer = 0;
  let remoteTimer = 0;
  let lastHtml = '';

  const moduleOf = (layerId) =>
    dataManager?.layers?.get?.(layerId)?.module || null;

  function paint() {
    if (!current) return;
    let s;
    try {
      s = current.build();
    } catch (error) {
      console.warn('[barreto] detalhes:', error);
      return;
    }
    if (!s) return close();
    panel.style.setProperty('--details-accent', s.accent || 'var(--accent)');
    $('.barreto-details-icon').textContent = s.icon || 'info';
    $('.barreto-details-kicker').textContent = s.kicker || '';
    $('#barreto-details-title').textContent = s.title || '';
    $('.barreto-details-subtitle').textContent = s.subtitle || '';
    const img = photo.querySelector('img');
    if (s.photo?.src && safeHref(s.photo.src)) {
      if (img.getAttribute('src') !== s.photo.src) img.src = s.photo.src;
      img.alt = `Foto de ${s.title}`;
      const a = photo.querySelector('a');
      const href = safeHref(s.photo.href);
      if (href) a.href = href;
      else a.removeAttribute('href');
      photo.querySelector('figcaption').textContent = s.photo.credit || '';
      photo.hidden = false;
    } else {
      photo.hidden = true;
      img.removeAttribute('src');
    }
    const html = renderSheetHtml(s);
    if (html !== lastHtml) {
      const scroll = panel.scrollTop;
      body.innerHTML = html;
      panel.scrollTop = scroll;
      lastHtml = html;
    }
  }

  function open(next) {
    clearInterval(liveTimer);
    clearInterval(remoteTimer);
    const same =
      current && current.layerId === next.layerId && current.id === next.id;
    current = next;
    if (!same) {
      lastHtml = '';
      panel.scrollTop = 0;
    }
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add('visible'));
    paint();
    if (next.live) liveTimer = setInterval(paint, LIVE_REFRESH_MS);
    if (next.remote) {
      next.remote().then(paint, () => paint());
      remoteTimer = setInterval(
        () => next.remote().then(paint, () => {}),
        REMOTE_REFRESH_MS,
      );
    }
  }

  function close() {
    clearInterval(liveTimer);
    clearInterval(remoteTimer);
    current = null;
    lastHtml = '';
    panel.classList.remove('visible');
    panel.hidden = true;
  }

  const closeIf = (layerId, id) => {
    if (
      current &&
      current.layerId === layerId &&
      (id == null || String(id) === current.id)
    )
      close();
  };

  async function getJson(url) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ---- aircraft (flights, military) and satellites: tracking layers
  function openTracked(layerId, id) {
    const mod = moduleOf(layerId);
    if (!mod?.getTrackedRecord) return;
    if (layerId === 'satellites') {
      open({
        layerId,
        id: String(id),
        live: true,
        build: () => {
          const rec = mod.getTrackedRecord();
          return rec ? satelliteSheet(rec) : null;
        },
      });
      return;
    }
    const state = { det: null, loading: true, rec: mod.getTrackedRecord() };
    const military = layerId === 'military';
    open({
      layerId,
      id: String(id),
      live: true,
      build: () => {
        const rec = mod.getTrackedRecord() || state.rec;
        if (!rec) return null;
        state.rec = rec;
        return aircraftSheet(rec, state.det, {
          military,
          loading: state.loading,
        });
      },
      remote: async () => {
        const hex = String(state.rec?.icao24 || id || '').toLowerCase();
        if (!/^[0-9a-f]{6}$/.test(hex)) {
          state.loading = false;
          return;
        }
        const cs = String(state.rec?.callsign || '').trim();
        try {
          state.det = await getJson(
            `/api/aircraft/details?hex=${hex}${cs ? `&callsign=${encodeURIComponent(cs)}` : ''}`,
          );
        } finally {
          state.loading = false;
        }
      },
    });
  }

  // ---- vessels and fires: context-store layers
  function openContext(record) {
    const layerId = record?.layerId;
    if (layerId === 'ais-live-vessels' && record.entity?.mmsi) {
      const vessel = record.entity;
      const state = { det: null, loading: true };
      open({
        layerId,
        id: String(vessel.mmsi),
        live: true,
        build: () => vesselSheet(vessel, state.det, { loading: state.loading }),
        remote: async () => {
          try {
            state.det = await getJson(
              `/api/vessels/details?mmsi=${encodeURIComponent(vessel.mmsi)}`,
            );
          } finally {
            state.loading = false;
          }
        },
      });
      return;
    }
    const fire = record?.entity?.__barretoFire;
    if (layerId === 'local-firms' && fire) {
      open({ layerId, id: String(record.id), build: () => fireSheet(fire) });
    }
  }

  // ---- Brazilian alert layers
  function openRecord({ layerId, id, record }) {
    if (!record) return;
    const build =
      layerId === 'inmet-alerts'
        ? () => capAlertSheet(record, { source: 'inmet' })
        : layerId === 'defesa-civil-alerts'
          ? () => capAlertSheet(record, { source: 'defesa' })
          : layerId === 'cemaden-alerts'
            ? () => cemadenSheet(record)
            : layerId === 'deter-alerts'
              ? () => deterSheet(record)
              : layerId === 'earthquakes'
                ? () => earthquakeSheet(record)
                : null;
    if (build) open({ layerId, id: String(id), build });
  }

  // Earthquakes have no click handler of their own: pick their discs here.
  let quakeHandler = null;
  function installQuakePick() {
    const viewer = styleManager?.viewer;
    if (quakeHandler || !viewer || viewer.isDestroyed?.())
      return Boolean(quakeHandler);
    quakeHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    quakeHandler.setInputAction((click) => {
      let picked = null;
      try {
        picked = viewer.scene.pick(click.position);
      } catch {
        return;
      }
      const entity = picked?.id;
      const id = typeof entity?.id === 'string' ? entity.id : '';
      if (id.startsWith('earthquake:')) {
        const record = entity.properties?.barreto?.getValue?.(
          Cesium.JulianDate.now(),
        );
        if (record)
          openRecord({ layerId: 'earthquakes', id: id.slice(11), record });
      } else if (current?.layerId === 'earthquakes') {
        close();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return true;
  }
  if (!installQuakePick()) {
    const retry = setInterval(() => {
      if (installQuakePick() || signal?.aborted) clearInterval(retry);
    }, 1000);
    signal?.addEventListener('abort', () => clearInterval(retry));
  }
  signal?.addEventListener('abort', () => quakeHandler?.destroy());

  const on = (type, fn) =>
    globalThis.addEventListener(
      type,
      (event) => {
        try {
          fn(event.detail || {});
        } catch (error) {
          console.warn('[barreto] detalhes:', error);
        }
      },
      { signal },
    );
  on('gev:awareness-subject-selected', (d) => {
    if (['flights', 'military', 'satellites'].includes(d.layerId))
      openTracked(d.layerId, d.id);
  });
  on('gev:awareness-subject-cleared', (d) => closeIf(d.layerId, d.id));
  on('gev:entity-selected', (d) => openContext(d));
  on('gev:entity-selection-cleared', (d) => closeIf(d.layerId));
  on('barreto:record-selected', (d) => openRecord(d));
  on('barreto:record-cleared', (d) => closeIf(d.layerId));

  // A layer switched off takes its sheet with it.
  const unsubscribe = dataManager?.subscribe?.(() => {
    if (
      current &&
      dataManager.isEnabled &&
      !dataManager.isEnabled(current.layerId)
    )
      close();
  });

  $('.barreto-details-close').addEventListener('click', close);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  });
  signal?.addEventListener('abort', () => {
    close();
    if (typeof unsubscribe === 'function') unsubscribe();
    panel.remove();
  });
  return { close, isOpen: () => Boolean(current) };
}
