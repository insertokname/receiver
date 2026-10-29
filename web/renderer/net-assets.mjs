// SPDX-License-Identifier: AGPL-3.0-only
//
// Build inputs of the network layer (web/net) for the bundles that include
// it: `virtual:web-net-assets` (where the page finds the transport's
// WebAssembly and its timer worker, their SHA-384 digests, checked when they
// are fetched, and the Tor directory snapshot), and Signal's WebSocket
// message code, generated with
// protopiler like Desktop's own protobuf code (web/net/generated/).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('..', import.meta.url));
export const transportWasm = (transportDir = join(WEB, 'transport/dist')) => join(transportDir, 'pkg/webtor_wasm_bg.wasm');
export const transportTimerWorker = (transportDir = join(WEB, 'transport/dist')) => join(transportDir, 'timer-worker.js');

const ID = '\0web-net-assets';

/**
 * `wasmUrl`, `timerWorkerUrl` and `torDirectory` are relative to the page
 * (the app, at the site's root). The app copies the WebAssembly and the
 * timer worker to transport/; build-site.sh puts the snapshot at the site's
 * transport/tor/.
 */
export async function netAssetsPlugin({
  wasmUrl = 'transport/webtor_wasm_bg.wasm',
  timerWorkerUrl = 'transport/timer-worker.js',
  torDirectory = 'transport/tor',
  transportDir,
} = {}) {
  const wasm = transportWasm(transportDir);
  if (!existsSync(wasm)) {
    throw new Error(`transport not built: run web/transport/build.sh first (${wasm} missing)`);
  }
  await mkdir(join(WEB, 'net/generated'), { recursive: true });
  execFileSync(
    join(WEB, 'node_modules/.bin/protopiler'),
    [
      join(WEB, 'protos/SubProtocol.proto'),
      '--output',
      join(WEB, 'net/generated/SubProtocol.mjs'),
      '--typedefs',
      join(WEB, 'net/generated/SubProtocol.d.mts'),
    ],
    { stdio: 'inherit' }
  );
  const sri = async path => `sha384-${createHash('sha384').update(await readFile(path)).digest('base64')}`;
  const assets = {
    transport: {
      wasmUrl,
      integrity: await sri(wasm),
      timerWorker: { url: timerWorkerUrl, integrity: await sri(transportTimerWorker(transportDir)) },
    },
    torDirectory,
  };
  return {
    assets,
    plugin: {
      name: 'web-net-assets',
      resolveId: id => (id === 'virtual:web-net-assets' ? ID : null),
      load: id => (id === ID ? `export default ${JSON.stringify(assets)};` : null),
    },
  };
}
