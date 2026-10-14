/**
 * barreto.top: Portuguese experience for the pt-BR build — chrome labels,
 * Brazilian cities, the "Brasil agora" panel, the "Como usar" guide and the
 * welcome card. Replaces the upstream first-run launcher there.
 */
import { initBrasilPanel } from './brasilPanel.js';
import { installBrazilCities, translateChrome } from './chrome.js';
import { initHelp } from './help.js';
import { initWelcome } from './welcome.js';

export function initBarretoExperience({ styleManager, dataManager } = {}) {
  const controller = new AbortController();
  const { signal } = controller;
  try {
    translateChrome();
  } catch (error) {
    console.warn('[barreto] chrome labels:', error);
  }
  installBrazilCities({ styleManager, signal });
  const help = initHelp({ signal });
  const brasilPanel = initBrasilPanel({ styleManager, dataManager, signal });
  initWelcome({ styleManager, dataManager, brasilPanel, help, signal });
  return { destroy: () => controller.abort(), help, brasilPanel };
}
