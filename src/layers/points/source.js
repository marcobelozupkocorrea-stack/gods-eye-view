import { createAlertSource } from '../alerts/source.js';

/** Same-origin INPE DETER snapshot (barreto.top). */
export const createDeterSource = (options = {}) =>
  createAlertSource({ endpoint: '/api/deter/alerts', ...options });

/** Same-origin Cemaden snapshot (barreto.top). */
export const createCemadenSource = (options = {}) =>
  createAlertSource({ endpoint: '/api/cemaden/alerts', ...options });
