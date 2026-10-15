/**
 * barreto.top: "Minhas visões" — save what you are looking at (position,
 * layers, style) under a name and come back to it with one tap. Kept on the
 * server per person (like "Meus lugares"), so they follow you between the
 * phone and the computer.
 */

const LOCAL_KEY = 'barreto:views:v1';
const CAMERA_KEYS = new Set([
  'lat',
  'lon',
  'alt',
  'heading',
  'pitch',
  'roll',
  'sat',
]);
let views = null;
const listeners = new Set();

const readLocal = () => {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(LOCAL_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const writeLocal = (list) => {
  try {
    globalThis.localStorage?.setItem(LOCAL_KEY, JSON.stringify(list));
  } catch {
    /* storage off */
  }
};
const emit = () => {
  for (const fn of listeners) {
    try {
      fn(views);
    } catch {
      /* keep going */
    }
  }
};

async function request(method, body) {
  const res = await fetch('/api/br/views', {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function loadViews() {
  if (views) return views;
  views = readLocal();
  try {
    const data = await request('GET');
    if (Array.isArray(data?.views)) {
      if (!data.views.length && views.length) await saveViews(views);
      else views = data.views;
    }
  } catch {
    /* offline: local copy */
  }
  writeLocal(views);
  emit();
  return views;
}

export async function saveViews(list) {
  views = list.slice(0, 20);
  writeLocal(views);
  emit();
  try {
    const data = await request('PUT', { views });
    if (Array.isArray(data?.views)) views = data.views;
  } catch {
    /* saved locally */
  }
  return views;
}

export function onViews(fn) {
  listeners.add(fn);
  if (views) fn(views);
  return () => listeners.delete(fn);
}

/** The share-link state of what is on screen now. */
export function currentHash(styleManager) {
  try {
    const params = styleManager?.shareLinkManager?._buildHashParams?.();
    if (params) return params.toString();
  } catch {
    /* fall back to the address bar */
  }
  return String(globalThis.location?.hash || '').replace(/^#/, '');
}

/** Same layers / style / panels, only the camera differs? */
export function sameExceptCamera(a, b) {
  const strip = (h) => {
    const p = new URLSearchParams(String(h || '').replace(/^#/, ''));
    for (const k of [...p.keys()])
      if (CAMERA_KEYS.has(k) || k === 'ts') p.delete(k);
    p.sort();
    return p.toString();
  };
  return strip(a) === strip(b);
}

export async function addView(styleManager, name) {
  const hash = currentHash(styleManager);
  if (!hash) return views;
  const entry = {
    name: String(name).trim().slice(0, 40),
    hash,
    at: Date.now(),
  };
  const rest = (views || []).filter(
    (v) => v.name.toLowerCase() !== entry.name.toLowerCase(),
  );
  return saveViews([entry, ...rest]);
}

export const removeView = (name) =>
  saveViews((views || []).filter((v) => v.name !== name));

/**
 * Go to a saved view: fly there when only the position changes, otherwise
 * reload with that state (layers and style come back exactly).
 */
export async function applyView(styleManager, view) {
  const slm = styleManager?.shareLinkManager;
  const now = currentHash(styleManager);
  if (slm && sameExceptCamera(now, view.hash)) {
    try {
      globalThis.history?.replaceState(
        globalThis.history.state,
        '',
        `#${view.hash}`,
      );
      const state = slm.parseInitialHash();
      if (state) {
        await slm.applyState(state);
        return 'voo';
      }
    } catch {
      /* fall through to a reload */
    }
  }
  globalThis.location.hash = view.hash;
  globalThis.location.reload();
  return 'recarregar';
}

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );

/**
 * Render the list and the "save" button into a container.
 * @returns {() => void} unsubscribe
 */
export function mountViewsList(container, { styleManager, onApplied } = {}) {
  const draw = (list) => {
    const items = (list || [])
      .map(
        (v) =>
          `<span class="barreto-view"><button type="button" data-view="${esc(v.name)}"><span class="material-symbols-outlined" aria-hidden="true">bookmark</span>${esc(v.name)}</button><button type="button" data-view="${esc(v.name)}" data-role="remove" aria-label="Apagar ${esc(v.name)}" title="Apagar"><span class="material-symbols-outlined" aria-hidden="true">close</span></button></span>`,
      )
      .join('');
    container.innerHTML = `
      <div class="barreto-views-list">${items || '<p class="al-muted">Nenhuma visão salva ainda. Arrume o mapa (lugar, camadas, estilo) e salve.</p>'}</div>
      <button type="button" class="al-btn barreto-views-save"><span class="material-symbols-outlined" aria-hidden="true">bookmark_add</span>Salvar esta visão</button>`;
  };
  container.addEventListener('click', async (e) => {
    const save = e.target.closest('.barreto-views-save');
    if (save) {
      const name = globalThis.prompt?.(
        'Nome desta visão (ex.: Chuva no litoral, Rodovias SP):',
        '',
      );
      if (name && name.trim()) await addView(styleManager, name);
      return;
    }
    const b = e.target.closest('[data-view]');
    if (!b) return;
    const v = (views || []).find((x) => x.name === b.dataset.view);
    if (!v) return;
    if (b.dataset.role === 'remove') {
      if (globalThis.confirm?.(`Apagar a visão "${v.name}"?`) !== false)
        await removeView(v.name);
      return;
    }
    onApplied?.(v);
    await applyView(styleManager, v);
  });
  const off = onViews(draw);
  draw(views || []);
  void loadViews();
  return off;
}

/** Computer: a "Minhas visões" button in the top bar with a small popover. */
export function installViewsButton({ styleManager, signal } = {}) {
  const nav = document.getElementById('top-center-actions');
  if (!nav || document.getElementById('barreto-views-btn')) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'barreto-views-btn';
  button.title = 'Minhas visões';
  button.setAttribute('aria-label', 'Minhas visões');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML =
    '<span class="material-symbols-outlined" aria-hidden="true">bookmark</span>';
  const pop = document.createElement('div');
  pop.id = 'barreto-views-pop';
  pop.hidden = true;
  pop.innerHTML =
    '<h3>Minhas visões</h3><div class="barreto-views-mount"></div>';
  document.body.append(pop);
  const off = mountViewsList(pop.querySelector('.barreto-views-mount'), {
    styleManager,
    onApplied: () => toggle(false),
  });
  function toggle(open = pop.hidden) {
    pop.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      const r = button.getBoundingClientRect();
      pop.style.top = `${Math.round(r.bottom + 10)}px`;
      pop.style.left = `${Math.round(Math.max(12, Math.min(r.left + r.width / 2 - 160, window.innerWidth - 332)))}px`;
    }
  }
  button.addEventListener('click', () => toggle());
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!pop.hidden && !pop.contains(e.target) && !button.contains(e.target))
        toggle(false);
    },
    { signal },
  );
  // Before the help button, which stays last.
  const help = document.getElementById('barreto-help-btn');
  if (help) nav.insertBefore(button, help);
  else nav.append(button);
  signal?.addEventListener('abort', () => {
    off();
    button.remove();
    pop.remove();
  });
  return button;
}
