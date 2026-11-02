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

// Node's 'base64url' encoding, which the package does not know ("Unknown
// encoding: base64url"; Desktop's username link, Bytes.toBase64url). Its
// base64 decoder already takes the URL-safe alphabet and missing padding, so
// decoding is 'base64'; encoding is 'base64' made URL-safe, without padding.
const isBase64url = (value: unknown): boolean =>
  typeof value === 'string' && value.toLowerCase() === 'base64url';
const toBase64 = (args: Array<unknown>): Array<unknown> =>
  args.map(arg => (isBase64url(arg) ? 'base64' : arg));
type Method = (...args: Array<unknown>) => unknown;
const statics = Buffer as unknown as Record<string, Method>;
for (const name of ['from', 'byteLength', 'alloc']) {
  const original = statics[name];
  statics[name] = function (this: unknown, ...args: Array<unknown>) {
    return original.apply(this, toBase64(args));
  };
}
const isEncoding = statics.isEncoding;
statics.isEncoding = (encoding: unknown) =>
  isBase64url(encoding) || isEncoding(encoding);
for (const name of ['write', 'fill', 'indexOf', 'lastIndexOf', 'includes']) {
  const original = proto[name] as Method;
  proto[name] = function (this: unknown, ...args: Array<unknown>) {
    return original.apply(this, toBase64(args));
  };
}
const toString = proto.toString as Method;
proto.toString = function (this: unknown, ...args: Array<unknown>) {
  if (!isBase64url(args[0])) return toString.apply(this, args);
  return (toString.call(this, 'base64', args[1], args[2]) as string)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};
proto.toLocaleString = proto.toString;

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
