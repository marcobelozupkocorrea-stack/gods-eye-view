/**
 * barreto.top: something shared to the installed app (Android "Compartilhar"
 * → Barreto). A Google Maps / Waze link, a "geo:" link, coordinates or an
 * address in a WhatsApp message become the destination of a route.
 */

export const SHARE_PARAMS = Object.freeze({
  title: 'compartilhado_titulo',
  text: 'compartilhado_texto',
  url: 'compartilhado_link',
});

const valid = (lat, lon) =>
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lon) <= 180 &&
  !(lat === 0 && lon === 0);

/** Coordinates inside a map link or a text, or null. */
export function coordsIn(text) {
  const s = decodeURIComponentSafe(String(text || ''));
  const patterns = [
    /@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/,
    /[?&](?:q|ll|query|destination|daddr|center|sll)=(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/,
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,
    /\bgeo:(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,
    /(?:^|[\s(])(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})(?=$|[\s)])/,
  ];
  for (const p of patterns) {
    const m = p.exec(s);
    if (m) {
      const lat = Number(m[1]);
      const lon = Number(m[2]);
      if (valid(lat, lon)) return { lat, lon };
    }
  }
  return null;
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const SHORT_LINK =
  /^https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|waze\.com\/ul|www\.waze\.com\/ul)\//i;

/**
 * What a share means.
 * @returns {{lat:number, lon:number, name:string} | {resolve:string, name:string} | {query:string, name:string} | null}
 */
export function parseShared({ title = '', text = '', url = '' } = {}) {
  const all = [title, text, url].filter(Boolean).join('\n');
  if (!all.trim()) return null;
  const links = [
    ...new Set([...(all.match(URL_RE) || []), url].filter(Boolean)),
  ];
  const plain = all
    .replace(URL_RE, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const name = (title || plain[0] || '').slice(0, 80);
  const point = coordsIn(links.join(' ')) || coordsIn(all);
  if (point) return { ...point, name: name || 'Lugar compartilhado' };
  const short = links.find((l) => SHORT_LINK.test(l));
  if (short) return { resolve: short, name };
  // Google Maps "search" links carry the address as text.
  for (const l of links) {
    try {
      const u = new URL(l);
      const q =
        u.searchParams.get('q') ||
        u.searchParams.get('query') ||
        u.searchParams.get('destination');
      if (q) return { query: q.slice(0, 160), name: name || q.slice(0, 80) };
      const place = /\/maps\/place\/([^/]+)/.exec(u.pathname);
      if (place) {
        const q2 = decodeURIComponentSafe(place[1]);
        return { query: q2.slice(0, 160), name: q2.slice(0, 80) };
      }
    } catch {
      /* not a URL */
    }
  }
  const query = plain.join(', ').slice(0, 160);
  return query.length >= 4 ? { query, name: name || query } : null;
}

/** Read the share params from a URL; null when nothing was shared. */
export function sharedFromUrl(href) {
  try {
    const u = new URL(href, 'http://x');
    const out = {
      title: u.searchParams.get(SHARE_PARAMS.title) || '',
      text: u.searchParams.get(SHARE_PARAMS.text) || '',
      url: u.searchParams.get(SHARE_PARAMS.url) || '',
    };
    return out.title || out.text || out.url ? out : null;
  } catch {
    return null;
  }
}
