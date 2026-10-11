// SPDX-License-Identifier: AGPL-3.0-only
//
// Desktop's code for the e2e runner, bundled for Node. The backup generator
// (ts/test-helpers/generateBackup.node.ts,
// used by ts/test-mock/backups/), bundled for Node so the e2e runner can make
// the encrypted backup a primary device sends when it links with
// link-and-sync. libsignal stays external: the native package Desktop's
// tests use. Needs Desktop's generated protobuf code (renderer/build.sh).

import { mkdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'rolldown';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const REPO = join(WEB, '..');
// Under the repository, so the external libsignal package resolves to the
// root's node_modules.
const OUT = join(WEB, 'dist/e2e-helpers');

async function bundle(name, entry) {
  await mkdir(OUT, { recursive: true });
  const builtins = new Set([...builtinModules, ...builtinModules.map(m => `node:${m}`)]);
  await build({
    cwd: REPO,
    input: { [name]: entry },
    platform: 'node',
    tsconfig: join(REPO, 'tsconfig.json'),
    external: id => builtins.has(id) || id === '@signalapp/libsignal-client' || /^@signalapp\/libsignal-client\/.*\.[cm]?js$/.test(id),
    plugins: [
      {
        // Subpath imports (dist/AccountKeys) need their extension in ESM.
        name: 'libsignal-subpaths',
        resolveId: id =>
          id.startsWith('@signalapp/libsignal-client/') && !/\.[cm]?js$/.test(id) ? { id: `${id}.js`, external: true } : null,
      },
    ],
    logLevel: 'silent',
    output: { dir: OUT, format: 'esm', entryFileNames: '[name].mjs' },
  });
  return import(pathToFileURL(join(OUT, `${name}.mjs`)).href);
}

export function loadBackupGenerator() {
  return bundle('generateBackup', join(REPO, 'ts/test-helpers/generateBackup.node.ts'));
}

/** Desktop's device name decryption (web/e2e/device-name.ts), for checking what a linked device sent. */
export function loadDeviceNameDecryptor() {
  return bundle('deviceName', join(WEB, 'e2e/device-name.ts'));
}
