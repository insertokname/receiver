// SPDX-License-Identifier: AGPL-3.0-only
//
// The parts of node:crypto that @signalapp/libsignal-client's TypeScript
// uses, on the Web Crypto API (the platform CSPRNG).

import { Buffer } from 'buffer';

export function randomBytes(size) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 65536) {
    globalThis.crypto.getRandomValues(bytes.subarray(i, i + 65536));
  }
  return bytes;
}

export function randomUUID() {
  return globalThis.crypto.randomUUID();
}
