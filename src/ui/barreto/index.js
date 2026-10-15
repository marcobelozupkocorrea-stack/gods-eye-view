/**
 * barreto.top: Portuguese experience for the pt-BR build — chrome labels,
 * Brazilian cities, the "Brasil agora" panel, the "Como usar" guide and the
 * welcome card. Replaces the upstream first-run launcher there.
 */
import { initAppShell } from './appShell.js';
import { initBrasilPanel } from './brasilPanel.js';
import {
  installBrazilCities,
  installMobilePanelsToggle,
  translateChrome,
} from './chrome.js';
import { installQuietCredits } from './credits.js';
import { initDetailsSheet } from './details.js';
import { initHelp } from './help.js';
import { installLiveText } from './liveText.js';
import { registerServiceWorker } from './pwa.js';
import { initRoutePlanner } from './routePlanner.js';
import { initSearchBar } from './searchBar.js';
import { installSessionWatch } from './session.js';
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
  installLiveText({ signal });
  installMobilePanelsToggle({ signal });
  installQuietCredits({ signal });
  installSessionWatch({ signal });
  initDetailsSheet({ dataManager, styleManager, signal });
  const routePlanner = initRoutePlanner({ styleManager, dataManager, signal });
  const searchBar = initSearchBar({ styleManager, routePlanner, signal });
  const help = initHelp({ signal });
  const brasilPanel = initBrasilPanel({ styleManager, dataManager, signal });
  const appShell = initAppShell({
    styleManager,
    brasilPanel,
    routePlanner,
    searchBar,
    help,
    signal,
  });
  registerServiceWorker();
  initWelcome({ styleManager, dataManager, brasilPanel, help, signal });
  return {
    destroy: () => controller.abort(),
    help,
    brasilPanel,
    appShell,
  };
}
