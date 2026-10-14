/**
 * barreto.top: type-ahead for a text field — places in Brazil first (Photon
 * via /api/br/search), CEP, favourites and "minha localização". Used by the
 * search window and every field of the route planner.
 */
import {
  escapeHtml,
  loadFavorites,
  onFavorites,
  placeIcon,
  searchPlaces,
} from './places.js';

const DEBOUNCE_MS = 280;

/**
 * @param {object} options
 * @param {HTMLInputElement} options.input
 * @param {(place: object) => void} options.onPick
 * @param {() => ({lat:number, lon:number}|null)} [options.getCenter]
 * @param {boolean} [options.offerLocation] add "Minha localização" when empty
 * @param {(place: object) => {icon:string,label:string,id:string}[]} [options.actions]
 *   extra buttons per result (e.g. "Rota até aqui"); clicking one calls onAction
 * @param {(id: string, place: object) => void} [options.onAction]
 * @param {AbortSignal} [options.signal]
 */
export function attachPlaceInput({
  input,
  onPick,
  getCenter = () => null,
  offerLocation = false,
  actions = null,
  onAction = () => {},
  signal,
}) {
  const list = document.createElement('ul');
  list.className = 'barreto-place-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.insertAdjacentElement('afterend', list);

  let items = [];
  let active = -1;
  let timer = 0;
  let request = null;
  let favs = [];
  let lastQuery = '';
  const unsubscribe = onFavorites((f) => {
    favs = f || [];
    if (!list.hidden && !input.value.trim()) showDefaults();
  });

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  }

  function render(entries, note = '') {
    items = entries;
    active = entries.length ? 0 : -1;
    list.innerHTML =
      entries
        .map((p, i) => {
          const extra = (actions?.(p) || [])
            .map(
              (a) =>
                `<button type="button" class="barreto-place-action" data-action="${escapeHtml(a.id)}" data-index="${i}" title="${escapeHtml(a.label)}" aria-label="${escapeHtml(a.label)}"><span class="material-symbols-outlined" aria-hidden="true">${escapeHtml(a.icon)}</span><span class="barreto-place-action-text">${escapeHtml(a.short || '')}</span></button>`,
            )
            .join('');
          return `<li class="barreto-place-item${i === active ? ' active' : ''}" role="option" data-index="${i}" aria-selected="${i === active}">
            <button type="button" class="barreto-place-main" data-index="${i}">
              <span class="material-symbols-outlined" aria-hidden="true">${escapeHtml(p.icon || placeIcon(p))}</span>
              <span class="barreto-place-text"><span class="barreto-place-name">${escapeHtml(p.name)}</span>${p.detail ? `<span class="barreto-place-detail">${escapeHtml(p.detail)}</span>` : ''}</span>
            </button>${extra}</li>`;
        })
        .join('') +
      (note ? `<li class="barreto-place-note">${escapeHtml(note)}</li>` : '');
    const show = entries.length > 0 || Boolean(note);
    list.hidden = !show;
    input.setAttribute('aria-expanded', String(show));
  }

  function showDefaults() {
    const entries = [];
    if (offerLocation)
      entries.push({
        name: 'Minha localização',
        detail: 'Usar o GPS deste aparelho',
        icon: 'my_location',
        myLocation: true,
      });
    for (const f of favs)
      entries.push({
        ...f,
        icon: /casa/i.test(f.name)
          ? 'home'
          : /trabalho|escrit/i.test(f.name)
            ? 'work'
            : 'star',
        favorite: true,
      });
    if (entries.length) render(entries);
    else close();
  }

  async function lookup(q) {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    render([], 'Buscando…');
    try {
      const results = await searchPlaces(q, getCenter(), {
        signal: controller.signal,
      });
      if (controller.signal.aborted || input.value.trim() !== q) return;
      const favHits = favs
        .filter((f) => f.name.toLowerCase().includes(q.toLowerCase()))
        .map((f) => ({ ...f, icon: 'star', favorite: true }));
      const all = [...favHits, ...results];
      render(all, all.length ? '' : 'Nenhum lugar encontrado');
    } catch (error) {
      if (!controller.signal.aborted)
        render([], 'Busca indisponível agora — tente de novo');
    }
  }

  function pick(index) {
    const place = items[index];
    if (!place) return;
    close();
    if (place.myLocation) {
      const geo = globalThis.navigator?.geolocation;
      if (!geo) return;
      input.value = 'Localizando…';
      geo.getCurrentPosition(
        (pos) => {
          const p = {
            name: 'Minha localização',
            detail: '',
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            myLocation: true,
          };
          input.value = p.name;
          onPick(p);
        },
        () => {
          input.value = '';
          input.placeholder = 'Permita a localização no navegador';
        },
        { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
      );
      return;
    }
    input.value = place.name;
    onPick(place);
  }

  const opts = { signal };
  input.addEventListener(
    'input',
    () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) {
        request?.abort();
        lastQuery = '';
        showDefaults();
        return;
      }
      if (q === lastQuery) return;
      timer = setTimeout(() => {
        lastQuery = q;
        void lookup(q);
      }, DEBOUNCE_MS);
    },
    opts,
  );
  input.addEventListener(
    'focus',
    () => {
      void loadFavorites();
      if (!input.value.trim()) showDefaults();
      else if (items.length) list.hidden = false;
    },
    opts,
  );
  input.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (list.hidden || !items.length) return;
        event.preventDefault();
        active =
          (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
          items.length;
        for (const li of list.querySelectorAll('.barreto-place-item'))
          li.classList.toggle('active', Number(li.dataset.index) === active);
      } else if (event.key === 'Enter') {
        // Our list answers Enter; the old search box must not fly as well.
        event.preventDefault();
        event.stopImmediatePropagation();
        const q = input.value.trim();
        if (!list.hidden && items[active]) pick(active);
        else if (q.length >= 2) {
          clearTimeout(timer);
          lastQuery = q;
          void lookup(q).then(() => {
            if (items.length === 1) pick(0);
          });
        }
      } else if (event.key === 'Escape') {
        if (!list.hidden) {
          event.stopPropagation();
          close();
        }
      }
    },
    { ...opts, capture: true },
  );
  list.addEventListener(
    'mousedown',
    (event) => event.preventDefault(), // keep focus in the field
    opts,
  );
  list.addEventListener(
    'click',
    (event) => {
      const action = event.target.closest?.('.barreto-place-action');
      if (action) {
        const place = items[Number(action.dataset.index)];
        if (place) {
          close();
          onAction(action.dataset.action, place);
        }
        return;
      }
      const main = event.target.closest?.('.barreto-place-main');
      if (main) pick(Number(main.dataset.index));
    },
    opts,
  );
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.target !== input && !list.contains(event.target)) close();
    },
    opts,
  );
  signal?.addEventListener('abort', () => {
    unsubscribe();
    request?.abort();
    clearTimeout(timer);
    list.remove();
  });
  return { close, list };
}
