// SPDX-License-Identifier: AGPL-3.0-only
//
// Bundles the libsignal checks page into OUT_DIR (argument): index.html,
// check.js (+ chunks) and libsignal_node.wasm next to them, where the loader
// fetches it from. @signalapp/libsignal-client resolves to the web build in
// ../dist/package; its node: imports to small browser shims.

import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkg = fileURLToPath(new URL('../dist/package', import.meta.url));
const outDir = process.argv[2];
if (!outDir) throw new Error('usage: node build.mjs OUT_DIR');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await build({
  // Module paths in the output are relative to this (reproducible builds).
  cwd: fileURLToPath(new URL('../../..', import.meta.url)),
  input: { check: join(here, 'main.js') },
  platform: 'browser',
  // Plain JS; ../tsconfig.json extends the submodule, which CI's build job doesn't check out.
  tsconfig: false,
  resolve: {
    alias: {
      '@signalapp/libsignal-client': pkg,
      'node:buffer': 'buffer',
      'node:assert': join(here, 'shims/node-assert.js'),
      'node:crypto': join(here, 'shims/node-crypto.js'),
    },
  },
  output: { dir: outDir, format: 'esm', entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js' },
});
await copyFile(join(here, 'index.html'), join(outDir, 'index.html'));
await copyFile(join(pkg, 'wasm/libsignal_node.wasm'), join(outDir, 'libsignal_node.wasm'));
