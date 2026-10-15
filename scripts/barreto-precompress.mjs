#!/usr/bin/env node
/**
 * barreto.top: write a Brotli copy (`file.br`) next to every large text file
 * of the build, so the server can send the smaller copy to browsers that
 * accept it (server/providers/assetCache.js → precompressedAssets). Brotli at
 * full strength shrinks Cesium.js and the app bundle about 25–30% more than
 * the gzip/zstd the proxy applies on the fly. Runs once per build, while the
 * previous release keeps serving.
 *
 * Usage: node scripts/barreto-precompress.mjs [distDir]
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const brotli = promisify(zlib.brotliCompress);
export const PRECOMPRESS_EXT = /\.(?:js|mjs|css|json|geojsonl|svg|html|wasm)$/i;
export const PRECOMPRESS_MIN_BYTES = 16 * 1024;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

export async function precompressDir(
  dir,
  { quality = 11, log = () => {} } = {},
) {
  let files = 0;
  let before = 0;
  let after = 0;
  for await (const file of walk(dir)) {
    if (!PRECOMPRESS_EXT.test(file)) continue;
    const info = await stat(file);
    if (info.size < PRECOMPRESS_MIN_BYTES) continue;
    const data = await readFile(file);
    const out = await brotli(data, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      },
    });
    // Only worth keeping when it actually saves something.
    if (out.length >= data.length * 0.95) continue;
    await writeFile(`${file}.br`, out);
    files += 1;
    before += data.length;
    after += out.length;
  }
  log(
    `[precompress] ${files} arquivos: ${Math.round(before / 1024)} KB → ${Math.round(after / 1024)} KB (brotli)`,
  );
  return { files, before, after };
}

const invokedDirectly = (() => {
  try {
    return (
      path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const dir = path.resolve(process.argv[2] || 'dist');
  await precompressDir(dir, { log: console.log });
}
