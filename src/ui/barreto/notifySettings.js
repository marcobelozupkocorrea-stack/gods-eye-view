/**
 * barreto.top: "Notificações de alertas" — turn alert notifications on for
 * this phone/computer and choose level, places and quiet hours. The server
 * (server/providers/alertas/push.js) does the matching and sending.
 */
import {
  pushLocation,
  pushPrefs,
  pushState,
  pushSubscribe,
  pushSummaryNow,
  pushTest,
  pushUnsubscribe,
} from './alertsApi.js';
import { removeArea } from './areas.js';

const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'className') node.className = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
};

/** VAPID public key (base64url) → bytes for pushManager.subscribe. */
export function keyBytes(base64url) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** What this browser can do, in plain words. */
export function pushSupport(env = globalThis) {
  const nav = env.navigator || {};
  const ios = /iPhone|iPad|iPod/.test(nav.userAgent || '');
  const standalone =
    env.matchMedia?.('(display-mode: standalone)')?.matches ||
    nav.standalone === true;
  if (!('serviceWorker' in nav) || !env.PushManager || !env.Notification) {
    if (ios && !standalone)
      return {
        ok: false,
        why: 'No iPhone, as notificações funcionam com o app instalado: Compartilhar → Adicionar à Tela de Início, e abra pelo ícone.',
      };
    return {
      ok: false,
      why: 'Este navegador não recebe notificações. Use o Chrome, Edge, Firefox ou o app instalado.',
    };
  }
  if (env.Notification.permission === 'denied')
    return {
      ok: false,
      why: 'As notificações estão bloqueadas para o barreto.top nas configurações do navegador/aparelho. Libere lá e volte aqui.',
    };
  return { ok: true, why: '' };
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function initNotifySettings({ signal } = {}) {
  const dialog = el('div', {
    id: 'barreto-notify',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'barreto-notify-title',
    hidden: true,
  });
  dialog.innerHTML = `
    <div class="barreto-notify-card">
      <header>
        <h2 id="barreto-notify-title"><span class="material-symbols-outlined" aria-hidden="true">notifications</span>Notificações de alertas</h2>
        <button type="button" class="barreto-notify-close" aria-label="Fechar"><span class="material-symbols-outlined" aria-hidden="true">close</span></button>
      </header>
      <div class="barreto-notify-body"></div>
    </div>`;
  document.body.append(dialog);
  const bodyEl = dialog.querySelector('.barreto-notify-body');
  let state = null;
  let subscribed = false;

  async function registration() {
    const sw = navigator.serviceWorker;
    const reg = await sw?.getRegistration?.('/');
    return reg || null;
  }

  async function refreshState() {
    state = await pushState();
    const reg = await registration().catch(() => null);
    const sub = await reg?.pushManager?.getSubscription?.().catch(() => null);
    subscribed = !!sub;
  }

  const save = async (patch) => {
    state.prefs = { ...state.prefs, ...patch };
    try {
      const r = await pushPrefs(state.prefs);
      state.prefs = r.prefs;
      if (state.prefs.usarLocal) void syncLocation(true);
    } catch {
      message('Não foi possível salvar agora. Tente de novo.');
    }
  };

  let msgEl = null;
  const message = (text) => {
    if (msgEl) msgEl.textContent = text;
  };

  async function turnOn() {
    const support = pushSupport();
    if (!support.ok) return message(support.why);
    const reg = await registration();
    if (!reg)
      return message(
        'O app ainda está se preparando. Recarregue a página e tente de novo.',
      );
    const permission = await Notification.requestPermission();
    if (permission !== 'granted')
      return message('Sem permissão, o aparelho não mostra notificações.');
    try {
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(state.publicKey),
      });
      await pushSubscribe(sub.toJSON(), state.prefs);
      subscribed = true;
      await refreshState();
      render();
      message('Pronto. Toque em "Enviar teste" para ver como chega.');
    } catch (err) {
      message(`Não deu para ligar: ${err?.message || err}`);
    }
  }

  async function turnOff() {
    const reg = await registration();
    const sub = await reg?.pushManager?.getSubscription?.();
    if (sub) {
      await pushUnsubscribe(sub.endpoint).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    subscribed = false;
    await refreshState().catch(() => {});
    render();
    message('Notificações desligadas neste aparelho.');
  }

  function radio(name, value, label, checked, onChange) {
    const input = el('input', {
      type: 'radio',
      name,
      value: String(value),
      checked,
    });
    input.addEventListener('change', () => input.checked && onChange(value));
    return el('label', { className: 'barreto-notify-opt' }, [
      input,
      el('span', { text: label }),
    ]);
  }
  function check(label, checked, onChange, hint) {
    const input = el('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { className: 'barreto-notify-opt' }, [
      input,
      el('span', {}, [
        el('span', { text: label }),
        hint ? el('small', { text: hint }) : null,
      ]),
    ]);
  }
  function hourSelect(value, onChange, label) {
    const s = el(
      'select',
      { className: 'brasil-select', 'aria-label': label },
      HOURS.map((h) =>
        el('option', {
          value: String(h),
          text: `${String(h).padStart(2, '0')}h`,
          selected: h === value,
        }),
      ),
    );
    s.addEventListener('change', () => onChange(Number(s.value)));
    return s;
  }

  function areaList() {
    const box = el('div', { className: 'barreto-notify-areas' });
    for (const a of state.areas || []) {
      const x = el(
        'button',
        { type: 'button', 'aria-label': `Apagar a área ${a.nome}` },
        [
          el('span', {
            className: 'material-symbols-outlined',
            'aria-hidden': 'true',
            text: 'close',
          }),
        ],
      );
      x.addEventListener('click', async () => {
        await removeArea(a.nome).catch(() => {});
        state.areas = (state.areas || []).filter((b) => b.nome !== a.nome);
        render();
      });
      box.append(
        el('span', { className: 'barreto-notify-area' }, [
          el('span', {
            className: 'material-symbols-outlined',
            'aria-hidden': 'true',
            text: 'radio_button_checked',
          }),
          el('span', { text: `${a.nome} · ${a.raioKm} km` }),
          x,
        ]),
      );
    }
    return box;
  }
  function summaryHour() {
    const hora = state.prefs.resumo?.hora ?? 7;
    const s = el(
      'select',
      { className: 'brasil-select', 'aria-label': 'Hora do resumo' },
      [4, 5, 6, 7, 8, 9, 10, 11, 12].map((h) =>
        el('option', {
          value: String(h),
          text: `${String(h).padStart(2, '0')}h`,
          selected: h === hora,
        }),
      ),
    );
    s.addEventListener(
      'change',
      () =>
        void save({
          resumo: { ...(state.prefs.resumo || {}), hora: Number(s.value) },
        }),
    );
    return s;
  }
  function summaryNow() {
    const b = el('button', {
      type: 'button',
      className: 'al-link',
      hidden: !subscribed,
      text: 'Enviar um agora',
    });
    b.addEventListener('click', async () => {
      try {
        const r = await pushSummaryNow();
        message(
          r.enviados
            ? 'Resumo enviado.'
            : 'Nada para resumir: salve lugares ou crie áreas.',
        );
      } catch {
        message('Falhou ao enviar o resumo.');
      }
    });
    return b;
  }

  function render() {
    const support = pushSupport();
    const p = state.prefs;
    const toggle = el(
      'button',
      {
        type: 'button',
        className: `barreto-notify-toggle${subscribed ? ' on' : ''}`,
      },
      [
        el('span', {
          className: 'material-symbols-outlined',
          'aria-hidden': 'true',
          text: subscribed ? 'notifications_active' : 'notifications_off',
        }),
        el('span', {
          text: subscribed
            ? 'Ligadas neste aparelho · desligar'
            : 'Ligar neste aparelho',
        }),
      ],
    );
    toggle.disabled = !support.ok && !subscribed;
    toggle.addEventListener(
      'click',
      () => void (subscribed ? turnOff() : turnOn()),
    );
    const test = el(
      'button',
      { type: 'button', className: 'al-btn', hidden: !subscribed },
      [
        el('span', {
          className: 'material-symbols-outlined',
          'aria-hidden': 'true',
          text: 'send',
        }),
        el('span', { text: 'Enviar teste' }),
      ],
    );
    test.addEventListener('click', async () => {
      try {
        const r = await pushTest();
        message(
          r.enviados
            ? 'Teste enviado. Deve aparecer em segundos.'
            : 'Nenhum aparelho recebeu. Desligue e ligue de novo.',
        );
      } catch {
        message('Falhou ao enviar o teste.');
      }
    });
    msgEl = el('p', {
      className: 'barreto-notify-msg',
      role: 'status',
      'aria-live': 'polite',
      text: support.ok ? '' : support.why,
    });
    const places = state.lugares?.length
      ? `Seus lugares: ${state.lugares.join(', ')}.`
      : 'Você ainda não tem lugares salvos — salve em Rota → Meus lugares.';
    const quiet = el('div', { className: 'barreto-notify-row' }, [
      hourSelect(
        p.silencio.de,
        (de) => void save({ silencio: { ...p.silencio, de } }),
        'Silêncio a partir de',
      ),
      el('span', { text: 'até' }),
      hourSelect(
        p.silencio.ate,
        (ate) => void save({ silencio: { ...p.silencio, ate } }),
        'Silêncio até',
      ),
    ]);
    bodyEl.replaceChildren(
      el('p', {
        className: 'al-muted',
        text: 'Avisa quando sai um alerta novo do INMET, da Defesa Civil ou do Cemaden que cobre os seus lugares. O mesmo risco avisado por duas fontes toca uma vez só.',
      }),
      toggle,
      test,
      msgEl,
      el('h3', { text: 'Quais alertas' }),
      radio(
        'nivel',
        3,
        'Só Extremo',
        p.minRank === 3,
        (v) => void save({ minRank: v }),
      ),
      radio(
        'nivel',
        2,
        'Alto e Extremo (recomendado)',
        p.minRank === 2,
        (v) => void save({ minRank: v }),
      ),
      radio(
        'nivel',
        1,
        'Todos (Moderado, Alto e Extremo)',
        p.minRank === 1,
        (v) => void save({ minRank: v }),
      ),
      el('h3', { text: 'Onde' }),
      check(
        'Meus lugares',
        p.usarLugares,
        (v) => void save({ usarLugares: v }),
        places,
      ),
      check(
        'Minha localização',
        p.usarLocal,
        (v) => void save({ usarLocal: v }),
        'Atualizada quando o app está aberto (precisão de ~1 km).',
      ),
      check(
        'Minhas áreas',
        p.usarAreas !== false,
        (v) => void save({ usarAreas: v }),
        state.areas?.length
          ? 'Alertas que tocam qualquer parte da área contam.'
          : 'Crie uma área segurando o dedo no mapa (botão direito no computador) → "Criar área de interesse aqui".',
      ),
      areaList(),
      el('h3', { text: 'Resumo da manhã' }),
      check(
        'Receber um resumo por dia',
        !!p.resumo?.ativo,
        (v) =>
          void save({ resumo: { ...(p.resumo || { hora: 7 }), ativo: v } }),
        'Previsão do dia, alertas e ocorrências de trânsito das suas áreas e lugares.',
      ),
      el('div', { className: 'barreto-notify-row' }, [
        el('span', { text: 'às' }),
        summaryHour(),
        summaryNow(),
      ]),
      el('h3', { text: 'Silêncio' }),
      check(
        'Silêncio à noite',
        p.silencio.ativo,
        (v) => void save({ silencio: { ...p.silencio, ativo: v } }),
        'Alertas extremos tocam mesmo assim.',
      ),
      quiet,
    );
  }

  let lastFocus = null;
  async function open() {
    lastFocus = document.activeElement;
    dialog.hidden = false;
    requestAnimationFrame(() => dialog.classList.add('visible'));
    bodyEl.replaceChildren(
      el('p', { className: 'al-muted', text: 'Carregando…' }),
    );
    try {
      await refreshState();
      render();
    } catch {
      bodyEl.replaceChildren(
        el('p', {
          className: 'al-muted',
          text: 'Sem resposta do servidor. Tente de novo em instantes.',
        }),
      );
    }
    dialog.querySelector('.barreto-notify-close')?.focus();
  }
  function close() {
    dialog.classList.remove('visible');
    dialog.hidden = true;
    lastFocus?.focus?.();
  }
  dialog
    .querySelector('.barreto-notify-close')
    .addEventListener('click', close);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });
  dialog.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });

  // "Minha localização": send a rounded position now and then while open.
  let lastSync = 0;
  async function syncLocation(force = false) {
    if (!force && Date.now() - lastSync < 30 * 60_000) return;
    try {
      const st = state || (await pushState());
      if (!st?.prefs?.usarLocal || !st.inscrito) return;
      const perm = await navigator.permissions
        ?.query({ name: 'geolocation' })
        .catch(() => null);
      if (perm && perm.state !== 'granted' && !force) return;
      navigator.geolocation?.getCurrentPosition(
        (pos) => {
          lastSync = Date.now();
          void pushLocation(pos.coords.latitude, pos.coords.longitude).catch(
            () => {},
          );
        },
        () => {},
        { enableHighAccuracy: false, timeout: 15_000, maximumAge: 15 * 60_000 },
      );
    } catch {
      /* best effort */
    }
  }
  const first = setTimeout(() => void syncLocation(), 20_000);
  const onVisible = () => {
    if (document.visibilityState === 'visible') void syncLocation();
  };
  document.addEventListener('visibilitychange', onVisible, { signal });
  signal?.addEventListener('abort', () => {
    clearTimeout(first);
    dialog.remove();
  });
  return { open, close };
}
