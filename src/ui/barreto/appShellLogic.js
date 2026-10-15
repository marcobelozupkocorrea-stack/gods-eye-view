/**
 * barreto.top: pure helpers of the phone app shell (see appShell.js).
 */
/**
 * Where a sheet drag ends: 'close', 'full' or 'half'.
 * @param {number} dy pixels moved (positive = down)
 * @param {boolean} full sheet was at full height
 * @param {number} velocity px/ms (positive = down)
 */
export function sheetSnap(dy, full, velocity = 0) {
  if (dy > 90 || velocity > 0.6) return full && dy < 260 ? 'half' : 'close';
  if (dy < -60 || velocity < -0.6) return 'full';
  return full ? 'full' : 'half';
}

/** "3 alertas" style badge text from the BRASIL AGORA badge. */
export function badgeCount(text) {
  const n = Number.parseInt(String(text ?? '').replace(/\D+/g, ''), 10);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n > 99 ? '99+' : String(n);
}

/** True when the page in `html` loads a different main bundle than `current`. */
export function isNewerBuild(html, current) {
  const m = /<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+)"/.exec(
    String(html || ''),
  );
  if (!m || !current) return false;
  const path = (u) => {
    try {
      return new URL(u, 'http://x').pathname;
    } catch {
      return u;
    }
  };
  return path(m[1]) !== path(current);
}
