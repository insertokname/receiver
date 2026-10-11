// SPDX-License-Identifier: AGPL-3.0-only
// node:buffer on the `buffer` package, plus the constants and globals it
// does not carry.

import * as bufferModule from 'buffer/index.js';

const base = bufferModule as typeof bufferModule & {
  SlowBuffer: unknown;
  INSPECT_MAX_BYTES: number;
  kMaxLength: number;
};

export const { Buffer, SlowBuffer, INSPECT_MAX_BYTES, kMaxLength } = base;

// Node's lower-case aliases the package has for the other methods but not
// for the 64-bit ones.
const proto = Buffer.prototype as unknown as Record<string, unknown>;
for (const name of ['readBigUInt64BE', 'readBigUInt64LE', 'writeBigUInt64BE', 'writeBigUInt64LE']) {
  proto[name.replace('UInt', 'Uint')] ??= proto[name];
}
export const kStringMaxLength = 2 ** 29 - 24; // V8's limit
export const constants = {
  MAX_LENGTH: kMaxLength,
  MAX_STRING_LENGTH: kStringMaxLength,
};
export const { atob, btoa, Blob, File } = globalThis;

export default {
  Buffer,
  SlowBuffer,
  INSPECT_MAX_BYTES,
  kMaxLength,
  kStringMaxLength,
  constants,
  atob,
  btoa,
  Blob,
  File,
};
