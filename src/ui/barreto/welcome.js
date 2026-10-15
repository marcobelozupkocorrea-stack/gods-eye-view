/**
 * barreto.top: Portuguese welcome that replaces the upstream first-run
 * launcher in the pt-BR build. Same show policy: every new browser session
 * until "Não mostrar de novo" is ticked; never on a share link.
 */
import * as Cesium from 'cesium';
import { flyToBrazil } from '../../camera.js';

export const WELCOME_STORAGE_KEY = 'barreto:welcome:v1';
export const WELCOME_SESSION_KEY = 'barreto:welcome-session:v1';

const read = (store, key) => {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
};
const write = (store, key, value) => {
  try {
    if (value === null) store()?.removeItem(key);
    else store()?.setItem(key, value);
  } catch {
    /* private mode: best effort */
  }
};
const local = () => globalThis.localStorage;
const session = () => globalThis.sessionStorage;

export function shouldShowWelcome({
  hasShareState = false,
  search = globalThis.location?.search,
} = {}) {
  if (hasShareState) return false;
  const params = new URLSearchParams(search || '');
  if (params.get('welcome') === '0' || params.get('embed') === '1')
    return false;
  if (params.get('welcome') === '1') return true;
  if (read(local, WELCOME_STORAGE_KEY) === 'suppressed') return false;
  return read(session, WELCOME_SESSION_KEY) !== 'dismissed';
}

/** Missions offered on the welcome card. */
export const WELCOME_MISSIONS = Object.freeze([
  Object.freeze({
    id: 'brasil',
    icon: 'warning',
    title: 'Alertas do Brasil',
    text: 'Alertas de tempo, Defesa Civil, Cemaden e queimadas, com a lista para filtrar',
    layers: [
      'local-firms',
      'inmet-alerts',
      'defesa-civil-alerts',
      'cemaden-alerts',
    ],
    fly: 'brazil',
    openBrasilPanel: true,
  }),
  Object.freeze({
    id: 'cameras',
    icon: 'videocam',
    title: 'CÂMERAS AO VIVO',
    text: 'Rodovias do DER-SP e cruzamentos da CET em São Paulo',
    layers: ['cctv'],
    fly: { lat: -23.56, lon: -46.64, altitude: 60_000 },
  }),
  Object.freeze({
    id: 'movimento',
    icon: 'flight',
    title: 'VOOS E NAVIOS',
    text: 'Aviões e embarcações em tempo real perto de São Paulo e Santos',
    layers: ['flights', 'ais-live-vessels'],
    fly: { lat: -23.75, lon: -46.45, altitude: 350_000 },
  }),
  Object.freeze({
    id: 'explorar',
    icon: 'public',
    title: 'EXPLORAR LIVREMENTE',
    text: 'Começar com o globo e escolher as camadas você mesmo',
    layers: [],
  }),
]);

export function initWelcome({
  styleManager,
  dataManager,
  brasilPanel,
  help,
  signal,
} = {}) {
  if (
    !shouldShowWelcome({ hasShareState: Boolean(styleManager?.hasShareState) })
  )
    return null;
  const card = document.createElement('aside');
  card.id = 'barreto-welcome';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-labelledby', 'barreto-welcome-title');
  card.innerHTML = `
    <span class="barreto-welcome-kicker">BARRETO · MONITORAMENTO</span>
    <h2 id="barreto-welcome-title">Por onde você quer começar?</h2>
    <p class="barreto-welcome-lead">Dados públicos e reais, atualizados ao vivo. Você pode mudar tudo depois no painel de camadas.</p>
    <div class="barreto-welcome-choices">
      ${WELCOME_MISSIONS.map(
        (m) => `<button type="button" data-mission="${m.id}">
          <span class="material-symbols-outlined" aria-hidden="true">${m.icon}</span>
          <span><strong>${m.title}</strong><small>${m.text}</small></span>
          <span class="material-symbols-outlined barreto-welcome-arrow" aria-hidden="true">arrow_forward</span>
        </button>`,
      ).join('')}
    </div>
    <button type="button" class="barreto-welcome-guide">
      <span class="material-symbols-outlined" aria-hidden="true">help</span> Ver o guia rápido de como usar
    </button>
    <div class="barreto-welcome-footer">
      <label><input type="checkbox" data-suppress /> <span>Não mostrar de novo</span></label>
      <span>Esc para fechar</span>
    </div>
    <p class="barreto-welcome-status" role="status" aria-live="polite"></p>`;
  document.body.append(card);
  requestAnimationFrame(() => card.classList.add('visible'));
  const status = card.querySelector('.barreto-welcome-status');
  const suppress = card.querySelector('[data-suppress]');

  const close = () => {
    write(session, WELCOME_SESSION_KEY, 'dismissed');
    write(local, WELCOME_STORAGE_KEY, suppress.checked ? 'suppressed' : null);
    card.classList.remove('visible');
    setTimeout(() => card.remove(), 250);
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);

  const fly = (target) => {
    const viewer = styleManager?.viewer;
    if (!viewer || viewer.isDestroyed?.() || !target) return;
    if (target === 'brazil') {
      flyToBrazil(viewer);
      return;
    }
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        target.lon,
        target.lat,
        target.altitude,
      ),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 2.5,
    });
  };

  card.querySelectorAll('[data-mission]').forEach((button) => {
    button.addEventListener('click', async () => {
      const mission = WELCOME_MISSIONS.find(
        (m) => m.id === button.dataset.mission,
      );
      if (!mission) return;
      card.querySelectorAll('button').forEach((b) => (b.disabled = true));
      status.textContent = mission.layers.length ? 'Ligando as camadas…' : '';
      fly(mission.fly);
      await Promise.allSettled(
        mission.layers.map((id) =>
          dataManager?.isEnabled?.(id)
            ? true
            : dataManager?.setEnabled?.(id, true, { origin: 'user' }),
        ),
      );
      if (mission.openBrasilPanel) brasilPanel?.open();
      close();
    });
  });
  card.querySelector('.barreto-welcome-guide').addEventListener('click', () => {
    close();
    help?.open();
  });
  signal?.addEventListener('abort', () => card.remove());
  return { close };
}
