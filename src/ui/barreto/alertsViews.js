/**
 * barreto.top: the parts of the Alertas panel that use the server's unified
 * alerts — "Perto de você", "Por lugar" (state → city, one line per hazard
 * even when two sources warn about it) and "Histórico".
 */
import * as Cesium from 'cesium';
import {
  KIND_ICON,
  KIND_OPTIONS,
  LEVEL_COLOR,
  dateTimeText,
  dayText,
  fetchCities,
  fetchWeather,
  fetchHistory,
  fetchNear,
  fetchStates,
  searchMunicipios,
  sourcesText,
  untilText,
} from './alertsApi.js';
import { loadFavorites, onFavorites } from './places.js';
import { loadAreas, onAreas } from './areas.js';
import { goCityNow } from './cityNow.js';
import { renderNearExtras } from './nearExtras.js';

const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'className') node.className = value;
    else if (key === 'style') node.setAttribute('style', value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
};
const icon = (name, cls = '') =>
  el('span', {
    className: `material-symbols-outlined ${cls}`.trim(),
    'aria-hidden': 'true',
    text: name,
  });
const levelPill = (rank, text) =>
  el('span', {
    className: 'al-level',
    style: `--lvl:${LEVEL_COLOR[rank] || LEVEL_COLOR[1]}`,
    text,
  });

function flyTo(viewer, lat, lon, height = 40_000) {
  if (!viewer || viewer.isDestroyed?.()) return;
  viewer.camera.cancelFlight?.();
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
    duration: 2,
  });
}

/** One hazard line: icon, name, level, sources, until. */
function hazardRow(r) {
  const meta = [sourcesText(r.sources), untilText(r.until)]
    .filter(Boolean)
    .join(' · ');
  return el('div', { className: 'al-hazard' }, [
    el(
      'span',
      {
        className: 'al-hazard-icon',
        style: `--lvl:${LEVEL_COLOR[r.rank]}`,
      },
      [icon(KIND_ICON[r.kind] || 'warning')],
    ),
    el('span', { className: 'al-hazard-text' }, [
      el('span', { className: 'al-hazard-title' }, [
        el('b', { text: r.label }),
        levelPill(r.rank, r.level),
      ]),
      el('span', { className: 'al-hazard-meta', text: meta }),
    ]),
  ]);
}

// ---------------------------------------------------------------- near you

const NEAR_KEY = 'barreto:perto:v1';
const readNearChoice = () => {
  try {
    return globalThis.localStorage?.getItem(NEAR_KEY) || '';
  } catch {
    return '';
  }
};
const writeNearChoice = (v) => {
  try {
    globalThis.localStorage?.setItem(NEAR_KEY, v);
  } catch {
    /* private mode */
  }
};

export function createNearCard({ styleManager, signal }) {
  const viewer = () => styleManager?.viewer;
  const card = el('section', {
    className: 'al-near',
    'aria-label': 'Alertas perto de você',
  });
  card.append(
    el('div', { className: 'al-near-head' }, [
      icon('near_me', 'al-near-icon'),
      el('b', { text: 'Perto de você' }),
    ]),
    el('p', { className: 'al-muted', text: 'Carregando…' }),
  );
  let favorites = [];
  let choice = readNearChoice(); // '' | '@local' | favourite name
  let lastPoint = null;
  let lastRadius = 0;
  let busy = false;

  const select = el('select', {
    className: 'al-near-select',
    'aria-label': 'Ver alertas de',
  });
  select.addEventListener('change', () => {
    choice = select.value;
    writeNearChoice(choice);
    void refresh();
  });

  let areaList = [];
  function options() {
    select.replaceChildren(
      el('option', { value: '@local', text: 'Minha localização' }),
      ...areaList.map((a) =>
        el('option', {
          value: `@area:${a.nome}`,
          text: `Área: ${a.nome} (${a.raioKm} km)`,
        }),
      ),
      ...favorites.map((f) => el('option', { value: f.name, text: f.name })),
    );
    select.value = choice || '@local';
  }

  async function geolocate() {
    const geo = globalThis.navigator?.geolocation;
    if (!geo) throw new Error('sem_gps');
    return new Promise((resolve, reject) =>
      geo.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        reject,
        { enableHighAccuracy: false, timeout: 10_000, maximumAge: 10 * 60_000 },
      ),
    );
  }

  async function permission() {
    try {
      return (await navigator.permissions?.query({ name: 'geolocation' }))
        ?.state;
    } catch {
      return null;
    }
  }

  function renderPrompt() {
    const button = el('button', { type: 'button', className: 'al-btn' }, [
      icon('my_location'),
      el('span', { text: 'Usar minha localização' }),
    ]);
    button.addEventListener('click', () => {
      choice = '@local';
      writeNearChoice(choice);
      void refresh({ ask: true });
    });
    card.replaceChildren(
      el('div', { className: 'al-near-head' }, [
        icon('near_me', 'al-near-icon'),
        el('b', { text: 'Perto de você' }),
      ]),
      el('p', {
        className: 'al-muted',
        text: 'Veja num relance os alertas da sua cidade ou de um dos seus lugares salvos.',
      }),
      button,
    );
  }

  async function refresh({ ask = false } = {}) {
    if (busy) return;
    busy = true;
    try {
      let point = null;
      let label = '';
      let raio = 0;
      if (choice?.startsWith('@area:')) {
        const a = areaList.find((x) => `@area:${x.nome}` === choice);
        if (a) {
          point = { lat: a.lat, lon: a.lon };
          label = `${a.nome} · ${a.raioKm} km`;
          raio = a.raioKm;
        }
      } else if (choice && choice !== '@local') {
        const f = favorites.find((x) => x.name === choice);
        if (f) {
          point = { lat: f.lat, lon: f.lon };
          label = f.name;
        }
      }
      if (!point) {
        const state = await permission();
        if (
          !ask &&
          state !== 'granted' &&
          !(choice === '@local' && state !== 'denied')
        ) {
          if (favorites.length && !choice) {
            choice = favorites[0].name;
            busy = false;
            return refresh();
          }
          renderPrompt();
          return;
        }
        try {
          point = await geolocate();
        } catch {
          if (favorites.length) {
            choice = favorites[0].name;
            busy = false;
            return refresh();
          }
          renderPrompt();
          return;
        }
      }
      lastPoint = point;
      lastRadius = raio;
      const data = await fetchNear(point.lat, point.lon, { signal }, raio);
      render(data, label);
    } catch (err) {
      if (signal?.aborted) return;
      card.replaceChildren(
        el('p', {
          className: 'al-muted',
          text: 'Não foi possível ver os alertas perto de você agora.',
        }),
      );
      console.warn('[perto]', err?.message || err);
    } finally {
      busy = false;
    }
  }

  function render(data, label) {
    options();
    const place = data.lugar ? `${data.lugar.nome}/${data.lugar.uf}` : '';
    const head = el('div', { className: 'al-near-head' }, [
      icon('near_me', 'al-near-icon'),
      el('span', { className: 'al-near-where' }, [
        el('b', { text: label ? `${label}` : 'Perto de você' }),
        place
          ? el('span', { className: 'al-muted', text: ` · ${place}` })
          : null,
      ]),
      select,
    ]);
    const body = data.riscos?.length
      ? el('div', { className: 'al-hazards' }, data.riscos.map(hazardRow))
      : el('p', { className: 'al-ok' }, [
          icon('check_circle'),
          el('span', { text: 'Nenhum alerta ativo aqui agora.' }),
        ]);
    card.classList.toggle('hot', (data.riscos?.[0]?.rank || 0) >= 3);
    card.replaceChildren(head, body);
    if (data.riscos?.length) {
      const go = el('button', { type: 'button', className: 'al-link' }, [
        el('span', { text: 'Ver no mapa' }),
        icon('chevron_right'),
      ]);
      go.addEventListener('click', () => {
        if (lastPoint) flyTo(viewer(), lastPoint.lat, lastPoint.lon, 60_000);
        card.dispatchEvent(
          new CustomEvent('barreto:near-go', { bubbles: true }),
        );
      });
      card.append(go);
    }
    const cityBtn = el('button', { type: 'button', className: 'al-city-now' }, [
      icon('location_city'),
      el('span', { text: 'Ver a cidade agora' }),
      el('small', { text: 'trânsito · ocorrências · ônibus · radar' }),
    ]);
    cityBtn.addEventListener('click', () => {
      card.dispatchEvent(new CustomEvent('barreto:near-go', { bubbles: true }));
      void goCityNow(lastPoint);
    });
    const weatherBox = el('div', { className: 'al-weather' }, [
      el('p', { className: 'al-muted', text: 'Carregando a previsão…' }),
    ]);
    const extras = el('div', { className: 'al-near-extras' });
    card.append(cityBtn, weatherBox, extras);
    if (lastPoint) {
      void renderWeather(weatherBox, lastPoint);
      renderNearExtras(extras, lastPoint, lastRadius, { signal });
    }
  }

  let daysOpen = false;
  async function renderWeather(box, point) {
    let w;
    try {
      w = await fetchWeather(point.lat, point.lon, { signal });
    } catch {
      box.replaceChildren(
        el('p', {
          className: 'al-muted',
          text: 'Previsão indisponível agora.',
        }),
      );
      return;
    }
    const a = w.agora;
    const nextRain = (w.horas || []).find((h) => (h.chuvaProb ?? 0) >= 60);
    const now = a
      ? el('div', { className: 'al-wx-now' }, [
          icon(a.icone || 'cloud', 'al-wx-icon'),
          el('b', { className: 'al-wx-temp', text: `${a.temp ?? '–'}°` }),
          el('span', { className: 'al-wx-desc' }, [
            el('span', { text: a.desc }),
            el('small', {
              text: [
                a.sensacao != null ? `sensação ${a.sensacao}°` : '',
                a.umidade != null ? `umidade ${a.umidade}%` : '',
                a.ventoKmh != null ? `vento ${a.ventoKmh} km/h` : '',
              ]
                .filter(Boolean)
                // Each item stays on one line; only the dots may wrap.
                .map((part) => part.replace(/ /g, '\u00a0'))
                .join(' · '),
            }),
          ]),
        ])
      : null;
    const rainLine = el('p', {
      className: 'al-wx-rain',
      text: nextRain
        ? `Chuva provável a partir das ${nextRain.hora} (${nextRain.chuvaProb}%).`
        : 'Sem chuva provável nas próximas 24 h.',
    });
    const hours = el(
      'div',
      {
        className: 'al-wx-hours',
        role: 'list',
        'aria-label': 'Próximas horas',
      },
      (w.horas || []).slice(0, 12).map((h) =>
        el('span', { className: 'al-wx-hour', role: 'listitem' }, [
          el('small', { text: h.hora }),
          icon(h.icone, 'al-wx-hicon'),
          el('b', { text: `${h.temp ?? '–'}°` }),
          el('small', {
            className: (h.chuvaProb ?? 0) >= 60 ? 'wet' : '',
            text: `${h.chuvaProb ?? 0}%`,
          }),
        ]),
      ),
    );
    const days = el(
      'div',
      { className: 'al-wx-days', hidden: !daysOpen },
      (w.dias || []).slice(0, 7).map((d) =>
        el('div', { className: 'al-wx-day' }, [
          el('span', { className: 'al-wx-dname', text: dayText(d.dia) }),
          icon(d.icone, 'al-wx-hicon'),
          el('span', { text: d.desc }),
          el('b', { text: `${d.min ?? '–'}° / ${d.max ?? '–'}°` }),
          el('small', {
            className: (d.chuvaProb ?? 0) >= 60 ? 'wet' : '',
            text: `${d.chuvaProb ?? 0}%${d.chuvaMm ? ` · ${d.chuvaMm} mm` : ''}`,
          }),
        ]),
      ),
    );
    const toggle = el('button', { type: 'button', className: 'al-link' }, [
      el('span', { text: daysOpen ? 'Esconder 7 dias' : 'Próximos 7 dias' }),
      icon(daysOpen ? 'expand_less' : 'expand_more'),
    ]);
    toggle.addEventListener('click', () => {
      daysOpen = !daysOpen;
      days.hidden = !daysOpen;
      toggle.firstChild.textContent = daysOpen
        ? 'Esconder 7 dias'
        : 'Próximos 7 dias';
      toggle.lastChild.textContent = daysOpen ? 'expand_less' : 'expand_more';
    });
    const air =
      w.ar?.aqi != null
        ? el('p', { className: 'al-wx-air' }, [
            el('span', {
              className: 'al-level',
              style: `--lvl:${w.ar.cor}`,
              text: `Ar: ${w.ar.nivel}`,
            }),
            el('small', {
              text: ` índice ${w.ar.aqi}${w.ar.pm25 != null ? ` · PM2,5 ${w.ar.pm25} µg/m³` : ''} (estimativa CAMS)`,
            }),
          ])
        : null;
    box.replaceChildren(
      ...[now, rainLine, hours, toggle, days, air].filter(Boolean),
      el('p', {
        className: 'al-muted al-small',
        text: 'Previsão: Open-Meteo · Ar: Copernicus CAMS',
      }),
    );
  }

  const off = onFavorites((list) => {
    favorites = list || [];
    options();
  });
  void loadFavorites().catch(() => {});
  const offAreas = onAreas((list) => {
    areaList = list || [];
    options();
  });
  void loadAreas().catch(() => {});
  signal?.addEventListener('abort', () => {
    off();
    offAreas();
  });
  return { el: card, refresh };
}

// ---------------------------------------------------------------- by place

export function createPlacesView({ styleManager, signal, onCity }) {
  const view = el('section', { className: 'al-places', hidden: true });
  let states = null;
  let current = null;
  let filterText = '';
  let shown = 60;

  const fold = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();

  async function showStates({ force = false } = {}) {
    current = null;
    if (!states || force) {
      view.replaceChildren(
        el('p', { className: 'al-muted', text: 'Carregando…' }),
      );
      try {
        states = await fetchStates({ signal });
      } catch {
        view.replaceChildren(
          el('p', {
            className: 'al-muted',
            text: 'Sem resposta do servidor. Tente de novo em instantes.',
          }),
        );
        return;
      }
    }
    const list = el('ol', { className: 'al-list' });
    for (const s of states.estados || []) {
      const b = el('button', { type: 'button', className: 'al-row' }, [
        el('span', {
          className: 'al-bar',
          style: `--lvl:${LEVEL_COLOR[s.rank]}`,
        }),
        el('span', { className: 'al-row-text' }, [
          el('span', { className: 'al-row-title' }, [
            el('b', { text: s.nome }),
            levelPill(s.rank, s.level),
          ]),
          el('span', {
            className: 'al-row-meta',
            text: `${s.alertas} alerta${s.alertas > 1 ? 's' : ''} · ${s.cidades.toLocaleString('pt-BR')} cidade${s.cidades === 1 ? '' : 's'}`,
          }),
          el(
            'span',
            { className: 'al-kinds' },
            s.tipos.slice(0, 6).map((t) =>
              el(
                'span',
                {
                  className: 'al-kind',
                  title: t.label,
                  style: `--lvl:${LEVEL_COLOR[t.rank]}`,
                },
                [icon(KIND_ICON[t.kind] || 'warning')],
              ),
            ),
          ),
        ]),
        icon('chevron_right', 'al-chev'),
      ]);
      b.addEventListener('click', () => void showCities(s.uf));
      list.append(el('li', {}, [b]));
    }
    view.replaceChildren(
      el('p', {
        className: 'al-muted',
        text: states.estados?.length
          ? 'Estados com alerta ativo. Um mesmo risco avisado por mais de uma fonte aparece uma vez só.'
          : 'Nenhum alerta ativo no Brasil agora.',
      }),
      list,
    );
  }

  async function showCities(uf) {
    current = uf;
    shown = 60;
    filterText = '';
    view.replaceChildren(
      el('p', { className: 'al-muted', text: 'Carregando…' }),
    );
    let data;
    try {
      data = await fetchCities(uf, { signal });
    } catch {
      view.replaceChildren(
        el('p', { className: 'al-muted', text: 'Sem resposta do servidor.' }),
      );
      return;
    }
    const back = el('button', { type: 'button', className: 'al-back' }, [
      icon('arrow_back'),
      el('span', { text: 'Estados' }),
    ]);
    back.addEventListener('click', () => void showStates());
    const search = el('input', {
      type: 'search',
      className: 'brasil-search',
      placeholder: `Cidade em ${data.nome}…`,
      'aria-label': 'Filtrar cidades',
      autocomplete: 'off',
    });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    const list = el('ol', { className: 'al-list' });
    const more = el('button', {
      type: 'button',
      className: 'brasil-more',
      hidden: true,
    });
    const draw = () => {
      const q = fold(filterText);
      const items = (data.cidades || []).filter(
        (c) => !q || fold(c.nome).includes(q),
      );
      list.replaceChildren(
        ...items.slice(0, shown).map((c) => {
          const b = el(
            'button',
            { type: 'button', className: 'al-row al-city' },
            [
              el('span', {
                className: 'al-bar',
                style: `--lvl:${LEVEL_COLOR[c.rank]}`,
              }),
              el('span', { className: 'al-row-text' }, [
                el('b', { className: 'al-row-title', text: c.nome }),
                el(
                  'span',
                  { className: 'al-hazards' },
                  c.riscos.map(hazardRow),
                ),
              ]),
            ],
          );
          b.addEventListener('click', () => {
            flyTo(styleManager?.viewer, c.lat, c.lon, 35_000);
            onCity?.(c);
          });
          return el('li', {}, [b]);
        }),
      );
      more.hidden = items.length <= shown;
      more.textContent = `Mostrar mais (${(items.length - shown).toLocaleString('pt-BR')})`;
    };
    let t;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        filterText = search.value;
        shown = 60;
        draw();
      }, 120);
    });
    more.addEventListener('click', () => {
      shown += 60;
      draw();
    });
    view.replaceChildren(
      el('div', { className: 'al-subhead' }, [
        back,
        el('b', {
          text: `${data.nome} · ${(data.cidades || []).length.toLocaleString('pt-BR')} cidades com alerta`,
        }),
      ]),
      search,
      list,
      more,
    );
    draw();
  }

  return {
    el: view,
    show() {
      view.hidden = false;
      if (current) void showCities(current);
      else void showStates({ force: true });
    },
    hide() {
      view.hidden = true;
    },
    refresh() {
      if (view.hidden) return;
      if (current) void showCities(current);
      else void showStates({ force: true });
    },
  };
}

// ---------------------------------------------------------------- history

const PERIODS = Object.freeze([
  [1, '24 h'],
  [7, '7 dias'],
  [30, '30 dias'],
  [90, '90 dias'],
  [365, '1 ano'],
]);

const UFS = Object.freeze([
  ['AC', 'Acre'],
  ['AL', 'Alagoas'],
  ['AP', 'Amapá'],
  ['AM', 'Amazonas'],
  ['BA', 'Bahia'],
  ['CE', 'Ceará'],
  ['DF', 'Distrito Federal'],
  ['ES', 'Espírito Santo'],
  ['GO', 'Goiás'],
  ['MA', 'Maranhão'],
  ['MT', 'Mato Grosso'],
  ['MS', 'Mato Grosso do Sul'],
  ['MG', 'Minas Gerais'],
  ['PA', 'Pará'],
  ['PB', 'Paraíba'],
  ['PR', 'Paraná'],
  ['PE', 'Pernambuco'],
  ['PI', 'Piauí'],
  ['RJ', 'Rio de Janeiro'],
  ['RN', 'Rio Grande do Norte'],
  ['RS', 'Rio Grande do Sul'],
  ['RO', 'Rondônia'],
  ['RR', 'Roraima'],
  ['SC', 'Santa Catarina'],
  ['SP', 'São Paulo'],
  ['SE', 'Sergipe'],
  ['TO', 'Tocantins'],
]);

/** Day counts → at most ~45 bars (weeks for long periods). */
export function barsFor(porDia, maxBars = 45) {
  const days = porDia || [];
  if (days.length <= maxBars)
    return days.map((d) => ({ label: d.dia, n: d.n }));
  const size = Math.ceil(days.length / maxBars);
  const out = [];
  for (let i = 0; i < days.length; i += size) {
    const chunk = days.slice(i, i + size);
    out.push({
      label: `${chunk[0].dia} a ${chunk[chunk.length - 1].dia}`,
      n: chunk.reduce((s, d) => s + d.n, 0),
    });
  }
  return out;
}

const dayLabel = (iso) => {
  const [, m, d] = String(iso).split('-');
  return d && m ? `${d}/${m}` : iso;
};

export function createHistoryView({ signal }) {
  const view = el('section', { className: 'al-history', hidden: true });
  const state = { dias: 30, uf: '', cidade: null, kind: '', shown: 40 };

  const ufSelect = el(
    'select',
    { className: 'brasil-select', 'aria-label': 'Estado' },
    [
      el('option', { value: '', text: 'Brasil inteiro' }),
      ...UFS.map(([uf, nome]) => el('option', { value: uf, text: nome })),
    ],
  );
  const kindSelect = el(
    'select',
    { className: 'brasil-select', 'aria-label': 'Tipo de alerta' },
    KIND_OPTIONS.map(([v, l]) => el('option', { value: v, text: l })),
  );
  const cityInput = el('input', {
    type: 'search',
    className: 'brasil-search',
    placeholder: 'Cidade (ex.: Mogi das Cruzes)',
    'aria-label': 'Cidade',
    autocomplete: 'off',
  });
  const cityList = el('div', { className: 'al-suggest', hidden: true });
  const cityChip = el('div', { className: 'al-city-chip', hidden: true });
  const periods = el('div', {
    className: 'brasil-chips',
    role: 'group',
    'aria-label': 'Período',
  });
  const out = el('div', { className: 'al-history-out' });

  function drawPeriods() {
    periods.replaceChildren(
      ...PERIODS.map(([d, label]) => {
        const b = el('button', {
          type: 'button',
          className: `brasil-chip${state.dias === d ? ' on' : ''}`,
          'aria-pressed': String(state.dias === d),
          text: label,
        });
        b.addEventListener('click', () => {
          state.dias = d;
          drawPeriods();
          void load();
        });
        return b;
      }),
    );
  }

  function setCity(m) {
    state.cidade = m;
    cityChip.hidden = !m;
    cityInput.hidden = !!m;
    cityList.hidden = true;
    if (m) {
      const x = el(
        'button',
        { type: 'button', 'aria-label': 'Tirar a cidade' },
        [icon('close')],
      );
      x.addEventListener('click', () => {
        setCity(null);
        cityInput.value = '';
        void load();
      });
      cityChip.replaceChildren(
        icon('location_city'),
        el('span', { text: `${m.nome}/${m.uf}` }),
        x,
      );
      ufSelect.value = m.uf;
      state.uf = m.uf;
    }
  }

  let suggestTimer;
  cityInput.addEventListener('keydown', (e) => e.stopPropagation());
  cityInput.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const q = cityInput.value.trim();
    if (q.length < 2) {
      cityList.hidden = true;
      return;
    }
    suggestTimer = setTimeout(async () => {
      try {
        const { municipios } = await searchMunicipios(q, { signal });
        cityList.replaceChildren(
          ...municipios.map((m) => {
            const b = el('button', {
              type: 'button',
              text: `${m.nome}/${m.uf}`,
            });
            b.addEventListener('click', () => {
              setCity(m);
              void load();
            });
            return b;
          }),
        );
        cityList.hidden = !municipios.length;
      } catch {
        cityList.hidden = true;
      }
    }, 180);
  });
  ufSelect.addEventListener('change', () => {
    state.uf = ufSelect.value;
    if (state.cidade && state.cidade.uf !== state.uf) setCity(null);
    void load();
  });
  kindSelect.addEventListener('change', () => {
    state.kind = kindSelect.value;
    void load();
  });

  let request = null;
  async function load() {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    out.replaceChildren(
      el('p', { className: 'al-muted', text: 'Carregando…' }),
    );
    let data;
    try {
      data = await fetchHistory(
        {
          dias: state.dias,
          uf: state.cidade ? '' : state.uf,
          cidade: state.cidade?.code,
          kind: state.kind,
          limit: 300,
        },
        { signal: controller.signal },
      );
    } catch {
      if (!controller.signal.aborted)
        out.replaceChildren(
          el('p', { className: 'al-muted', text: 'Sem resposta do servidor.' }),
        );
      return;
    }
    state.shown = 40;
    render(data);
  }

  function render(data) {
    const where = state.cidade
      ? `${state.cidade.nome}/${state.cidade.uf}`
      : state.uf
        ? UFS.find(([u]) => u === state.uf)?.[1]
        : 'Brasil inteiro';
    const period = PERIODS.find(([d]) => d === state.dias)?.[1];
    const summary = el('p', { className: 'al-summary' }, [
      el('b', { text: data.total.toLocaleString('pt-BR') }),
      el('span', {
        text: ` alerta${data.total === 1 ? '' : 's'} em ${period} · ${where}`,
      }),
    ]);
    const bars = barsFor(data.porDia);
    const max = Math.max(1, ...bars.map((b) => b.n));
    const chart = el(
      'div',
      { className: 'al-chart', role: 'img', 'aria-label': 'Alertas por dia' },
      bars.map((b) =>
        el('span', {
          className: 'al-chart-bar',
          style: `--h:${Math.round((b.n / max) * 100)}%`,
          title: `${b.label.split(' a ').map(dayLabel).join(' a ')}: ${b.n}`,
        }),
      ),
    );
    const axis = bars.length
      ? el('div', { className: 'al-chart-axis' }, [
          el('span', { text: dayLabel(bars[0].label.split(' a ')[0]) }),
          el('span', { text: 'hoje' }),
        ])
      : null;
    const types = el(
      'div',
      { className: 'al-types' },
      data.porTipo.map((t) =>
        el('div', { className: 'al-type' }, [
          icon(KIND_ICON[t.kind] || 'warning'),
          el('span', { className: 'al-type-name', text: t.label }),
          el('span', {
            className: 'al-type-bar',
            style: `--w:${Math.round((t.n / Math.max(1, data.porTipo[0].n)) * 100)}%`,
          }),
          el('b', { text: t.n.toLocaleString('pt-BR') }),
        ]),
      ),
    );
    const levels = el(
      'div',
      { className: 'al-levels' },
      data.porNivel.map((l) => levelPill(l.rank, `${l.label}: ${l.n}`)),
    );
    const list = el('ol', { className: 'al-list al-hlist' });
    const more = el('button', {
      type: 'button',
      className: 'brasil-more',
      hidden: true,
    });
    const draw = () => {
      list.replaceChildren(
        ...data.itens.slice(0, state.shown).map((i) =>
          el('li', { className: 'al-hitem' }, [
            el('span', {
              className: 'al-bar',
              style: `--lvl:${LEVEL_COLOR[i.rank]}`,
            }),
            el('span', { className: 'al-row-text' }, [
              el('span', { className: 'al-row-title' }, [
                el('b', { text: i.tipo }),
                levelPill(i.rank, i.level),
                i.ativo
                  ? el('span', { className: 'al-live', text: 'ativo' })
                  : null,
              ]),
              el('span', {
                className: 'al-row-meta',
                text: `${dateTimeText(i.inicio)}${i.fim ? ` → ${dateTimeText(i.fim)}` : ''} · ${i.fonte}: ${i.event}`,
              }),
              el('span', {
                className: 'al-row-meta',
                text: i.areaText || i.ufs.join(', '),
              }),
            ]),
          ]),
        ),
      );
      more.hidden = data.itens.length <= state.shown;
      more.textContent = `Mostrar mais (${data.itens.length - state.shown})`;
    };
    more.addEventListener('click', () => {
      state.shown += 40;
      draw();
    });
    draw();
    const since = data.gravadoDesde
      ? el('p', {
          className: 'al-muted al-small',
          text: `Histórico gravado pelo Barreto desde ${dateTimeText(data.gravadoDesde)} (INMET, Defesa Civil e Cemaden).${data.total > data.itens.length ? ` Lista mostra os ${data.itens.length} mais recentes.` : ''}`,
        })
      : null;
    out.replaceChildren(
      summary,
      data.total ? chart : null,
      data.total ? axis : null,
      data.total ? el('h4', { className: 'al-h', text: 'Por tipo' }) : null,
      data.total ? types : null,
      data.total ? levels : null,
      data.total ? el('h4', { className: 'al-h', text: 'Alertas' }) : null,
      list,
      more,
      since,
    );
  }

  drawPeriods();
  view.append(
    periods,
    el('div', { className: 'brasil-filters' }, [ufSelect, kindSelect]),
    el('div', { className: 'al-city-wrap' }, [cityInput, cityChip, cityList]),
    out,
  );

  return {
    el: view,
    show() {
      view.hidden = false;
      void load();
    },
    hide() {
      view.hidden = true;
    },
    refresh() {
      if (!view.hidden) void load();
    },
  };
}
