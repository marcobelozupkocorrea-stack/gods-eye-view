/**
 * barreto.top: "Linha do tempo" — go back up to 3 hours, 10 minutes at a
 * time, on the Brazilian rain radars and the GOES-19 cloud images, and see
 * how many alerts were active at that moment (from the history).
 */
import { fetchHistory } from './alertsApi.js';

const STEPS = 18; // 18 × 10 min = 3 h
const STEP_MIN = 10;
const CLOCK = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  hour: '2-digit',
  minute: '2-digit',
});

/** Slider position → minutes before now (0 = agora). */
export const offsetFor = (value) =>
  (STEPS - Math.max(0, Math.min(STEPS, Math.round(value)))) * STEP_MIN;

export function agoText(min) {
  if (!min) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `há ${h} h${m ? ` ${m}` : ''}`;
}

export function initTimeline({ dataManager, signal } = {}) {
  const bar = document.createElement('section');
  bar.id = 'barreto-timeline';
  bar.hidden = true;
  bar.setAttribute('aria-label', 'Linha do tempo');
  bar.innerHTML = `
    <button type="button" class="barreto-tl-play" aria-label="Animar" title="Animar as últimas 3 horas"><span class="material-symbols-outlined" aria-hidden="true">play_arrow</span></button>
    <div class="barreto-tl-main">
      <div class="barreto-tl-head"><b class="barreto-tl-when">agora</b><span class="barreto-tl-alerts"></span></div>
      <input type="range" min="0" max="${STEPS}" step="1" value="${STEPS}" aria-label="Momento" />
      <div class="barreto-tl-scale"><span>3 h atrás</span><span>agora</span></div>
    </div>
    <button type="button" class="barreto-tl-close" aria-label="Fechar a linha do tempo" title="Fechar (volta para agora)"><span class="material-symbols-outlined" aria-hidden="true">close</span></button>`;
  document.body.append(bar);
  const range = bar.querySelector('input');
  const when = bar.querySelector('.barreto-tl-when');
  const alertsEl = bar.querySelector('.barreto-tl-alerts');
  const playBtn = bar.querySelector('.barreto-tl-play');
  range.addEventListener('keydown', (e) => e.stopPropagation());

  const module = (id) => dataManager?.layers?.get?.(id)?.module || null;
  const isOn = (id) => !!dataManager?.isEnabled?.(id);

  let playTimer = 0;
  let alertsTimer = 0;
  let alertsReq = null;

  function apply(value) {
    const offset = offsetFor(value);
    const at = Math.floor((Date.now() - offset * 60_000) / 600_000) * 600_000;
    when.textContent = offset
      ? `${agoText(offset)} · ${CLOCK.format(new Date(at))}`
      : `agora · ${CLOCK.format(new Date())}`;
    module('brazil-radar')?.setTimeOffset?.(offset);
    if (isOn('weather-satellite'))
      module('weather-satellite')?.seekTime?.(
        offset ? new Date(at).toISOString() : null,
      );
    clearTimeout(alertsTimer);
    alertsTimer = setTimeout(async () => {
      alertsReq?.abort();
      alertsReq = new AbortController();
      try {
        const data = await fetchHistory(
          { em: offset ? at : Date.now(), limit: 1 },
          { signal: alertsReq.signal },
        );
        const top = data.porTipo
          .slice(0, 2)
          .map((t) => `${t.label.toLowerCase()} ${t.n}`)
          .join(', ');
        alertsEl.textContent = `${data.total} alerta${data.total === 1 ? '' : 's'} ativo${data.total === 1 ? '' : 's'}${top ? ` · ${top}` : ''}`;
      } catch {
        if (!alertsReq?.signal.aborted) alertsEl.textContent = '';
      }
    }, 350);
  }

  function stopPlay() {
    clearInterval(playTimer);
    playTimer = 0;
    playBtn.querySelector('span').textContent = 'play_arrow';
    playBtn.setAttribute('aria-label', 'Animar');
  }
  function play() {
    if (playTimer) return stopPlay();
    if (Number(range.value) >= STEPS) range.value = '0';
    apply(range.value);
    playBtn.querySelector('span').textContent = 'pause';
    playBtn.setAttribute('aria-label', 'Pausar');
    playTimer = setInterval(() => {
      const next = Number(range.value) + 1;
      range.value = String(next > STEPS ? 0 : next);
      apply(range.value);
    }, 1400);
  }

  range.addEventListener('input', () => {
    stopPlay();
    apply(range.value);
  });
  playBtn.addEventListener('click', play);

  async function open() {
    bar.hidden = false;
    document.body.classList.add('barreto-timeline-open');
    // The timeline is mostly about rain: turn the Brazilian radars on.
    if (!isOn('brazil-radar') && !isOn('weather-satellite'))
      await dataManager?.setEnabled?.('brazil-radar', true, { origin: 'user' });
    apply(range.value);
  }
  function close() {
    stopPlay();
    range.value = String(STEPS);
    apply(STEPS);
    bar.hidden = true;
    document.body.classList.remove('barreto-timeline-open');
  }
  bar.querySelector('.barreto-tl-close').addEventListener('click', close);
  signal?.addEventListener('abort', () => {
    stopPlay();
    clearTimeout(alertsTimer);
    alertsReq?.abort();
    bar.remove();
  });
  return {
    open,
    close,
    toggle: () => (bar.hidden ? open() : close()),
    isOpen: () => !bar.hidden,
  };
}

/** Computer: a "Linha do tempo" button in the top bar. */
export function installTimelineButton(timeline, { signal } = {}) {
  const nav = document.getElementById('top-center-actions');
  if (!nav || document.getElementById('barreto-timeline-btn')) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'barreto-timeline-btn';
  button.title = 'Linha do tempo (radar, nuvens e alertas das últimas 3 horas)';
  button.setAttribute('aria-label', 'Linha do tempo');
  button.innerHTML =
    '<span class="material-symbols-outlined" aria-hidden="true">history</span>';
  button.addEventListener('click', () => void timeline.toggle());
  const help = document.getElementById('barreto-help-btn');
  if (help) nav.insertBefore(button, help);
  else nav.append(button);
  signal?.addEventListener('abort', () => button.remove());
  return button;
}
