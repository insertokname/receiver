// SPDX-License-Identifier: AGPL-3.0-only
//
// The SQL worker's WebAssembly modules, fetched from the site and checked
// against the SHA-384 digests recorded at build time (renderer/build.mjs).

import type { WasmAsset } from './protocol.ts';

export class StorageUnavailableError extends Error {
  override name = 'StorageUnavailableError';
}

export async function fetchModule(asset: WasmAsset, base: string): Promise<WebAssembly.Module> {
  const url = new URL(asset.path, base).href;
  let response: Response;
  try {
    response = await fetch(url, { integrity: asset.integrity, credentials: 'same-origin' });
  } catch (error) {
    throw new StorageUnavailableError(
      `cannot load ${asset.path} (${error instanceof Error ? error.message : String(error)})`
    );
  }
  if (!response.ok) {
    throw new StorageUnavailableError(`cannot load ${asset.path}: HTTP ${response.status}`);
  }
  return WebAssembly.compile(await response.arrayBuffer());
}
