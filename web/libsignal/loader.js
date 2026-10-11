// SPDX-License-Identifier: AGPL-3.0-only
//
// Takes the place of `node-gyp-build` in the web build of
// @signalapp/libsignal-client: libsignal's own Node-API module, compiled to
// WebAssembly (wasm32-wasip1), runs on emnapi instead of Node.
//
// Instantiating WebAssembly is asynchronous while the package loads its
// native module synchronously, so `await initLibsignal()` must complete
// before anything imports @signalapp/libsignal-client.

import { instantiateNapiModule } from '@emnapi/core';
import { getDefaultContext } from '@emnapi/runtime';
import { WASI } from '@tybys/wasm-util';

// build.sh fills in the Subresource Integrity digest of libsignal_node.wasm.
const WASM_INTEGRITY = '@WASM_INTEGRITY@';
const WASM_URL = new URL('./libsignal_node.wasm', import.meta.url);

const WASI_ESUCCESS = 0;
const WASI_ENOSYS = 52;

let nativeModule;
let pending;

/**
 * Loads and instantiates the WebAssembly module. Safe to call repeatedly;
 * after a failure the next call tries again.
 *
 * @param {{ wasm?: WebAssembly.Module | BufferSource }} [options] the module
 *   or its bytes; by default it is fetched from next to this file and checked
 *   against the digest recorded at build time.
 */
export function initLibsignal({ wasm } = {}) {
  if (nativeModule) return Promise.resolve();
  pending ??= instantiate(wasm).then(
    exports => {
      nativeModule = withUnavailableStubs(exports);
      pending = undefined;
    },
    error => {
      pending = undefined;
      throw new Error('libsignal: failed to load the WebAssembly module', { cause: error });
    }
  );
  return pending;
}

/** Called by the package's Native.js in place of node-gyp-build. */
export default function load() {
  if (!nativeModule) {
    throw new Error(
      'libsignal: `await initLibsignal()` must complete before @signalapp/libsignal-client is imported'
    );
  }
  return nativeModule;
}

async function compile(wasm) {
  if (wasm instanceof WebAssembly.Module) return wasm;
  if (wasm) return WebAssembly.compile(wasm);
  const response = await fetch(WASM_URL, { integrity: WASM_INTEGRITY });
  if (!response.ok) throw new Error(`fetching ${WASM_URL}: HTTP ${response.status}`);
  if (response.headers.get('content-type')?.startsWith('application/wasm')) {
    return WebAssembly.compileStreaming(response);
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

async function instantiate(wasm) {
  const module = await compile(wasm);
  let memory;
  const wasi = new WASI({ version: 'preview1' });
  const { napiModule } = await instantiateNapiModule(module, {
    context: getDefaultContext(),
    wasi,
    getMemory: exports => (memory = exports.memory),
    overwriteImports(imports) {
      // The WASI shim falls back to Math.random() in some environments; key
      // generation must never do that, so randomness comes only from the
      // platform CSPRNG and its absence is an error.
      imports.wasi_snapshot_preview1.random_get = (buf, len) => {
        if (typeof globalThis.crypto?.getRandomValues !== 'function') return WASI_ENOSYS;
        const bytes = new Uint8Array(memory.buffer, buf >>> 0, len >>> 0);
        for (let i = 0; i < bytes.length; i += 65536) {
          globalThis.crypto.getRandomValues(bytes.subarray(i, i + 65536));
        }
        return WASI_ESUCCESS;
      };
      return imports;
    },
  });
  return napiModule.exports;
}

// Networking (libsignal-net) is not part of the web build. Its entry points
// throw a clear error instead of "is not a function".
function withUnavailableStubs(exports) {
  return new Proxy(exports, {
    get(target, name, receiver) {
      if (typeof name === 'string' && name !== 'then' && !(name in target)) {
        return () => {
          throw new Error(`libsignal: ${name} is not available in the web build`);
        };
      }
      return Reflect.get(target, name, receiver);
    },
  });
}
