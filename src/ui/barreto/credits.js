/**
 * barreto.top: quieter map attribution. The full credit line shows when the
 * map opens, then folds after a few seconds to the logos (Cesium ion and
 * Google stay on screen, as their terms require) plus a "Créditos" link.
 * Hovering, focusing or tapping the line unfolds it again, and "Créditos"
 * still opens the complete per-source attribution list.
 */
export const CREDITS_FOLD_DELAY_MS = 8_000;
export const CREDITS_REFOLD_MS = 10_000;

/** Credits that must stay visible even when folded: logos, Google and Esri. */
export function creditStaysVisible({ text = '', hasImage = false } = {}) {
  return hasImage || /google|esri/i.test(text);
}

export function markCredits(container) {
  const screen = container.querySelector('.cesium-credit-textContainer');
  if (!screen) return;
  for (const child of screen.children) {
    const keep = creditStaysVisible({
      text: child.textContent || '',
      hasImage:
        Boolean(child.querySelector?.('img, svg')) || child.tagName === 'IMG',
    });
    if (keep) child.dataset.barretoKeep = '1';
    else delete child.dataset.barretoKeep;
  }
}

export function installQuietCredits({ signal } = {}) {
  let container = null;
  let foldTimer = 0;
  let observer = null;
  const fold = () => container?.classList.add('barreto-credits-folded');
  const unfold = (refoldAfter = CREDITS_REFOLD_MS) => {
    if (!container) return;
    container.classList.remove('barreto-credits-folded');
    clearTimeout(foldTimer);
    foldTimer = setTimeout(fold, refoldAfter);
  };

  const attach = () => {
    container = document.getElementById('cesium-credits');
    if (!container) return false;
    container.classList.add('barreto-credits');
    markCredits(container);
    observer = new MutationObserver(() => markCredits(container));
    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const expand = container.querySelector('.cesium-credit-expand-link');
    if (expand) {
      expand.textContent = 'Créditos';
      expand.title = 'Ver todas as fontes e licenças dos dados';
    }
    container.addEventListener('pointerenter', () => unfold(), { signal });
    container.addEventListener('focusin', () => unfold(), { signal });
    container.addEventListener(
      'click',
      (event) => {
        if (event.target.closest('a')) return;
        if (container.classList.contains('barreto-credits-folded')) unfold();
        else fold();
      },
      { signal },
    );
    foldTimer = setTimeout(fold, CREDITS_FOLD_DELAY_MS);
    return true;
  };

  // Cesium creates the credit container with the viewer; wait for it.
  let tries = 0;
  const poll = setInterval(() => {
    if (attach() || ++tries > 60) clearInterval(poll);
  }, 500);
  signal?.addEventListener('abort', () => {
    clearInterval(poll);
    clearTimeout(foldTimer);
    observer?.disconnect();
    container?.classList.remove('barreto-credits', 'barreto-credits-folded');
  });
}
