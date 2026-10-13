#!/usr/bin/env node
/**
 * barreto.top self-check: exercise the Brazilian data proxies exactly as the
 * browser would (same middleware, real upstreams) and print one line each.
 * Run on the server after a deploy: `node scripts/barreto-selfcheck.mjs`.
 * Exits non-zero when any source fails, so the result is visible in logs.
 */
import { inmetAlertsProxy } from '../server/providers/inmetAlerts.js';
import { defesaCivilAlertsProxy } from '../server/providers/defesaCivilAlerts.js';
import { firmsProxy } from '../server/providers/firms.js';
import {
  loadCetSpSources,
  loadDerSpSources,
} from '../server/providers/cctv/brazil.js';
import { fetchCctvImageFromUpstream } from '../server/providers/cctv/media.js';
import {
  HLS_LIMITS,
  fetchHlsBytes,
  parseHlsMedia,
} from '../server/providers/cctv/stream.js';

function mount(plugin) {
  let handler = null;
  plugin.configurePreviewServer({
    middlewares: {
      use: (_path, fn) => {
        handler = fn;
      },
    },
  });
  return (url = '/') =>
    new Promise((resolve) => {
      const res = {
        headersSent: false,
        writeHead(status) {
          this.status = status;
        },
        end(body) {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            /* reported below */
          }
          resolve({ status: this.status, json });
        },
      };
      handler({ url, method: 'GET' }, res);
    });
}

const checks = [
  [
    'INMET avisos',
    mount(inmetAlertsProxy()),
    (j) => {
      const rows = j?.rows || [];
      const polys = rows.reduce((n, r) => n + r.polygons.length, 0);
      return `${rows.length} avisos ativos, ${polys} áreas`;
    },
  ],
  [
    'Defesa Civil (IDAP)',
    mount(defesaCivilAlertsProxy()),
    (j) => {
      const rows = j?.rows || [];
      const states = new Set(rows.map((r) => r.senderName).filter(Boolean));
      return `${rows.length} alertas ativos de ${states.size} emissores`;
    },
  ],
  [
    'Queimadas (FIRMS + INPE)',
    mount(firmsProxy()),
    (j) =>
      `${j?.count ?? 0} focos · ` +
      (j?.sources || [])
        .map((s) => `${s.source}=${s.ok ? s.count : 'falhou'}`)
        .join(', '),
  ],
];

/** Camera packs: list size plus one real frame / live segment each. */
async function cameraCheck(label, load, probe) {
  const started = Date.now();
  try {
    const cams = await load();
    if (!cams.length) throw new Error('lista vazia');
    const detail = await probe(cams);
    console.log(
      `[selfcheck] OK   ${label}: ${cams.length} câmeras · ${detail} · ${Date.now() - started} ms`,
    );
    return true;
  } catch (err) {
    console.log(`[selfcheck] FALHA ${label}: ${err?.message || err}`);
    return false;
  }
}

const cameraChecks = [
  () =>
    cameraCheck('Câmeras DER-SP (vídeo)', loadDerSpSources, async (cams) => {
      for (const cam of cams.slice(0, 4)) {
        try {
          const text = (
            await fetchHlsBytes(cam.url, { maxBytes: HLS_LIMITS.playlistBytes })
          ).toString('utf8');
          const segments = parseHlsMedia(text, cam.url);
          const last = segments.at(-1);
          const bytes = await fetchHlsBytes(last.uri, {
            maxBytes: HLS_LIMITS.segmentBytes,
          });
          return `${cam.id} ao vivo (${segments.length} segmentos, último ${Math.round(bytes.length / 1024)} KB)`;
        } catch {
          /* try the next camera */
        }
      }
      throw new Error('nenhum vídeo respondeu');
    }),
  () =>
    cameraCheck('Câmeras CET-SP (imagens)', loadCetSpSources, async (cams) => {
      const frame = await fetchCctvImageFromUpstream(cams[0].snapshotUrl);
      if (!frame) throw new Error(`imagem de ${cams[0].id} não veio`);
      return `${cams[0].id} ${frame.contentType} ${Math.round(frame.body.length / 1024)} KB`;
    }),
];

let failed = 0;
for (const run of cameraChecks) if (!(await run())) failed += 1;
for (const [name, call, summarize] of checks) {
  const started = Date.now();
  try {
    const { status, json } = await call('/');
    const ok = status === 200 && json;
    if (!ok) failed += 1;
    console.log(
      `[selfcheck] ${ok ? 'OK  ' : 'FALHA'} ${name}: HTTP ${status} · ` +
        `${ok ? summarize(json) : JSON.stringify(json)} · ${Date.now() - started} ms`,
    );
  } catch (err) {
    failed += 1;
    console.log(`[selfcheck] FALHA ${name}: ${err?.message || err}`);
  }
}
process.exitCode = failed ? 1 : 0;
