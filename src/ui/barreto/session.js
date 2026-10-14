/**
 * barreto.top: notice when the login session has ended. The site sits behind
 * oauth2-proxy; once the session lapses every /api call answers 401 and the
 * layers just read "indisponível". Ask the proxy directly every couple of
 * minutes (and when the tab comes back) and offer a one-tap re-login.
 */
export const SESSION_POLL_MS = 120_000;

/** 401 from the proxy means signed out; anything else (dev server, 202) is fine. */
export const sessionExpired = (status) => status === 401;

export function installSessionWatch({
  signal,
  fetchImpl = globalThis.fetch,
} = {}) {
  let banner = null;
  let checking = false;
  const show = () => {
    if (banner) return;
    banner = document.createElement('div');
    banner.id = 'barreto-session';
    banner.setAttribute('role', 'alert');
    banner.innerHTML = `
      <span class="material-symbols-outlined" aria-hidden="true">lock</span>
      <span>Sua sessão expirou e as camadas pararam de atualizar.</span>
      <button type="button">Entrar de novo</button>`;
    banner
      .querySelector('button')
      .addEventListener('click', () => globalThis.location.reload());
    document.body.append(banner);
  };
  const check = async () => {
    if (checking || banner || document.visibilityState === 'hidden') return;
    checking = true;
    try {
      const res = await fetchImpl('/oauth2/auth', {
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'manual',
      });
      if (sessionExpired(res.status)) show();
    } catch {
      /* offline: the next check decides */
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(check, SESSION_POLL_MS);
  const onVisible = () => {
    if (document.visibilityState === 'visible') check();
  };
  document.addEventListener('visibilitychange', onVisible, { signal });
  globalThis.addEventListener?.('focus', check, { signal });
  signal?.addEventListener('abort', () => {
    clearInterval(timer);
    banner?.remove();
  });
  return { check };
}
