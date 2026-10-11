// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Loads and instantiates libsignal's WebAssembly module. Must complete before
 * anything imports `@signalapp/libsignal-client`. Safe to call repeatedly;
 * after a failure the next call tries again.
 */
export function initLibsignal(options?: {
  /** The compiled module or its bytes; by default it is fetched from next to the loader. */
  wasm?: WebAssembly.Module | BufferSource;
}): Promise<void>;

/** Used by the package's Native.js in place of node-gyp-build. */
export default function load(dir?: string): Record<string, unknown>;
