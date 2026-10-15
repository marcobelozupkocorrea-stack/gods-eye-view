/**
 * barreto.top: alert history.
 *
 * Every alert seen by the collector is written once (first time seen) to a
 * monthly JSON-lines file under /app/data/alertas, with a closing line when it
 * leaves the feeds. Kept for 400 days; read back into memory at start (a year
 * is a few tens of MB) and queried by state, city, kind, source and period.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { KIND_LABEL, LEVELS, SOURCE_LABEL } from './unify.js';

const KEEP_DAYS = 400;
const DAY_MS = 86_400_000;

const DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
/** "2026-10-14" in Brasília time. */
export const dayKey = (ms) => DAY_FMT.format(new Date(ms));
const monthKey = (ms) => dayKey(ms).slice(0, 7);

/** The record kept per alert (no polygons). */
export function historyRecord(alert, seenAt) {
  return {
    id: alert.id,
    source: alert.source,
    kind: alert.kind,
    event: alert.event,
    rank: alert.rank,
    level: alert.level,
    headline: alert.headline || '',
    issuer: alert.issuer || '',
    areaText: alert.areaText || '',
    onset: alert.onset ?? null,
    expires: alert.expires ?? null,
    firstSeen: seenAt,
    lastSeen: null,
    ufs: alert.ufs,
    cities: alert.cities,
    center: alert.center,
  };
}

export function createHistory({
  dir,
  now = () => Date.now(),
  log = console,
} = {}) {
  /** id → record */
  const records = new Map();
  let loaded = null;

  async function load() {
    if (loaded) return loaded;
    loaded = (async () => {
      let files = [];
      try {
        files = (await fsp.readdir(dir))
          .filter((f) => /^historico-\d{4}-\d{2}\.jsonl$/.test(f))
          .sort();
      } catch {
        return;
      }
      const cutoff = now() - KEEP_DAYS * DAY_MS;
      for (const file of files) {
        const month = file.slice(10, 17);
        // Drop whole months older than the retention.
        if (Date.parse(`${month}-01T00:00:00-03:00`) + 32 * DAY_MS < cutoff) {
          await fsp.unlink(path.join(dir, file)).catch(() => {});
          continue;
        }
        const text = await fsp
          .readFile(path.join(dir, file), 'utf8')
          .catch(() => '');
        for (const line of text.split('\n')) {
          if (!line) continue;
          let item;
          try {
            item = JSON.parse(line);
          } catch {
            continue;
          }
          if (item.t === 'a' && item.r?.id && !records.has(item.r.id))
            records.set(item.r.id, item.r);
          else if (item.t === 'f' && records.has(item.id))
            records.get(item.id).lastSeen = item.at;
        }
      }
      log.info?.(`[alertas] histórico: ${records.size} alertas carregados`);
    })();
    return loaded;
  }

  async function append(lines, at) {
    if (!lines.length) return;
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(
      path.join(dir, `historico-${monthKey(at)}.jsonl`),
      `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
      'utf8',
    );
  }

  /**
   * Record what is in the feeds now. Returns the alerts never seen before.
   * @param {object[]} current unified alerts
   * @param {number} [at]
   * @param {Set<string>} [okSources] sources that answered this round
   */
  async function observe(current, at = now(), okSources = null) {
    await load();
    const lines = [];
    const fresh = [];
    const currentIds = new Set();
    for (const a of current) {
      currentIds.add(a.id);
      const known = records.get(a.id);
      if (!known) {
        const r = historyRecord(a, at);
        records.set(a.id, r);
        lines.push({ t: 'a', r });
        fresh.push(a);
      } else if (known.lastSeen) {
        // Back in the feed after dropping out (upstream hiccup): reopen.
        known.lastSeen = null;
        lines.push({ t: 'f', id: a.id, at: null });
      }
    }
    for (const r of records.values()) {
      if (r.lastSeen || currentIds.has(r.id)) continue;
      // A source that failed this round says nothing about its alerts.
      if (okSources && !okSources.has(r.source)) continue;
      r.lastSeen = at;
      lines.push({ t: 'f', id: r.id, at });
    }
    try {
      await append(lines, at);
    } catch (err) {
      log.warn?.('[alertas] histórico não gravado:', err?.message || err);
    }
    return fresh;
  }

  /**
   * @param {{ dias?: number, uf?: string, cidade?: number, kind?: string,
   *   source?: string, minRank?: number, limit?: number }} q
   */
  async function query(q = {}) {
    await load();
    const at = now();
    const dias = Math.max(1, Math.min(KEEP_DAYS, Number(q.dias) || 30));
    const since = at - dias * DAY_MS;
    // "em": alerts active at that moment (the timeline), whatever the period.
    const em = Number(q.em);
    const atMoment = Number.isFinite(em) && em > 0 ? em : null;
    const cidade = Number(q.cidade) || null;
    const uf = q.uf ? String(q.uf).toUpperCase() : null;
    const hits = [];
    for (const r of records.values()) {
      const end = r.lastSeen ?? at;
      if (atMoment !== null) {
        if (r.firstSeen > atMoment || end < atMoment) continue;
      } else if (end < since) continue;
      if (uf && !r.ufs?.includes(uf)) continue;
      if (cidade && !r.cities?.includes(cidade)) continue;
      if (q.kind && r.kind !== q.kind) continue;
      if (q.source && r.source !== q.source) continue;
      if (q.minRank && r.rank < q.minRank) continue;
      hits.push(r);
    }
    hits.sort((a, b) => b.firstSeen - a.firstSeen);
    const count = (key) => {
      const m = new Map();
      for (const r of hits) m.set(key(r), (m.get(key(r)) || 0) + 1);
      return m;
    };
    const porDia = [];
    const days = count((r) => dayKey(Math.max(r.firstSeen, since)));
    for (let t = since; t <= at + DAY_MS; t += DAY_MS) {
      const d = dayKey(t);
      if (!porDia.length || porDia[porDia.length - 1].dia !== d)
        porDia.push({ dia: d, n: days.get(d) || 0 });
    }
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 200));
    let gravadoDesde = null;
    for (const r of records.values())
      if (gravadoDesde === null || r.firstSeen < gravadoDesde)
        gravadoDesde = r.firstSeen;
    return {
      desde: since,
      gravadoDesde,
      total: hits.length,
      porTipo: [...count((r) => r.kind).entries()]
        .map(([kind, n]) => ({ kind, label: KIND_LABEL[kind] || kind, n }))
        .sort((a, b) => b.n - a.n),
      porNivel: [3, 2, 1, 0]
        .map((rank) => ({
          rank,
          label: LEVELS[rank],
          n: hits.filter((r) => r.rank === rank).length,
        }))
        .filter((x) => x.n),
      porFonte: [...count((r) => r.source).entries()].map(([source, n]) => ({
        source,
        label: SOURCE_LABEL[source] || source,
        n,
      })),
      porDia: porDia.slice(-Math.min(porDia.length, 400)),
      itens: hits.slice(0, limit).map((r) => ({
        id: r.id,
        fonte: SOURCE_LABEL[r.source] || r.source,
        source: r.source,
        kind: r.kind,
        tipo: KIND_LABEL[r.kind] || r.kind,
        event: r.event,
        rank: r.rank,
        level: r.level,
        headline: r.headline,
        areaText: r.areaText,
        ufs: r.ufs,
        nCidades: r.cities?.length || 0,
        inicio: r.onset ?? r.firstSeen,
        fim: r.lastSeen ?? null,
        ativo: !r.lastSeen,
        center: r.center,
      })),
    };
  }

  return { load, observe, query, size: () => records.size };
}

/** Synchronous existence check used by tests. */
export const historyFileExists = (dir, at) =>
  fs.existsSync(path.join(dir, `historico-${monthKey(at)}.jsonl`));
