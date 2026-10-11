// SPDX-License-Identifier: AGPL-3.0-only
//
// Builds the service worker (sw.ts -> <dir>/sw.js) for the app in `dir`,
// with the app's file list: every file's SHA-256 and the build's id, a
// digest of that list. sw.js only changes when a file of the app changes,
// so a redeployment that only refreshes the Tor directory snapshot (which
// is not in `dir`: build-site.sh adds it) never offers an update.
//
//   node sw/build.mjs <dir>     (renderer/build.mjs calls buildServiceWorker)

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const MANIFEST_ID = '\0web-sw-manifest';

// Downloaded when the app first uses them, not when the worker installs:
// images, sounds, fonts (the ones index.html preloads are core) and the
// translations other than English (the app needs one language).
function isCore(path, preloaded) {
  if (preloaded.has(path)) return true;
  if (/^(images|sounds|fonts)\//.test(path)) return false;
  if (/^locales\/[^/]+\//.test(path) && !path.startsWith('locales/en/')) return false;
  return true;
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'));
  }
  return out.sort();
}

export async function buildServiceWorker(dir, { minify = true } = {}) {
  const html = await readFile(join(dir, 'index.html'), 'utf8');
  const preloaded = new Set([...html.matchAll(/<link rel="preload" href="([^"]+)"/g)].map(m => m[1]));
  const files = {};
  const core = [];
  for (const path of await listFiles(dir)) {
    if (path === 'sw.js' || path.startsWith('transport/tor/')) continue;
    files[path] = createHash('sha256').update(await readFile(join(dir, path))).digest('hex');
    if (isCore(path, preloaded)) core.push(path);
  }
  const buildId = createHash('sha256')
    .update(Object.entries(files).map(([path, digest]) => `${digest}  ${path}\n`).join(''))
    .digest('hex');
  const manifest = { build: buildId, files, core };

  const bundle = await build({
    input: join(HERE, 'sw.ts'),
    platform: 'browser',
    plugins: [
      {
        name: 'web-sw-manifest',
        resolveId: id => (id === 'virtual:web-sw-manifest' ? MANIFEST_ID : null),
        load: id => (id === MANIFEST_ID ? `export default ${JSON.stringify(manifest)};` : null),
      },
    ],
    write: false,
    output: { format: 'iife', minify, comments: { legal: false } },
  });
  const [chunk] = bundle.output;
  await writeFile(join(dir, 'sw.js'), chunk.code);
  const coreBytes = (await Promise.all(core.map(async p => (await readFile(join(dir, p))).length))).reduce((a, b) => a + b, 0);
  return { build: buildId, files: Object.keys(files).length, core: core.length, coreBytes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: node sw/build.mjs <dir>');
  const result = await buildServiceWorker(dir);
  console.log(`service worker: build ${result.build.slice(0, 16)}, ${result.files} files, ${result.core} core (${(result.coreBytes / 1e6).toFixed(1)} MB)`);
}
