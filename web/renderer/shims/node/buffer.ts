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
