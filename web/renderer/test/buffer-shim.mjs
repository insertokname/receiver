// SPDX-License-Identifier: AGPL-3.0-only
//
// Differential test of the node:buffer shim (shims/node/buffer.ts) against
// Node's own Buffer for the 'base64url' encoding the `buffer` package lacks
// (Desktop's username link: Bytes.toBase64url / fromBase64url).
// Run: node renderer/test/buffer-shim.mjs

import { randomBytes } from 'node:crypto';
import { Buffer as Shim } from '../shims/node/buffer.ts';

let checks = 0;
const eq = (a, b, what) => {
  checks += 1;
  const same = typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean' ? a === b : Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
  if (!same) throw new Error(`mismatch: ${what}: ${String(a)} != ${String(b)}`);
};

for (let size = 0; size < 70; size += 1) {
  const bytes = randomBytes(size);
  const shim = Shim.from(bytes);
  const url = bytes.toString('base64url');
  eq(shim.toString('base64url'), url, `toString base64url (${size})`);
  eq(shim.toString('BASE64URL'), url, `toString BASE64URL (${size})`);
  eq(shim.toString('base64url', 1, size - 1), bytes.toString('base64url', 1, size - 1), `toString base64url range (${size})`);
  eq(shim.toLocaleString('base64url'), url, `toLocaleString (${size})`);
  eq(Shim.from(url, 'base64url'), bytes, `from base64url (${size})`);
  eq(Shim.from(bytes.toString('base64'), 'base64url'), Buffer.from(bytes.toString('base64'), 'base64url'), `from padded base64 as base64url (${size})`);
  eq(Shim.byteLength(url, 'base64url'), Buffer.byteLength(url, 'base64url'), `byteLength (${size})`);
  const written = Shim.alloc(size);
  eq(written.write(url, 'base64url'), Buffer.alloc(size).write(url, 'base64url'), `write returns (${size})`);
  eq(written, bytes, `write (${size})`);
  eq(shim.toString('base64'), bytes.toString('base64'), `base64 unchanged (${size})`);
  eq(shim.toString('hex'), bytes.toString('hex'), `hex unchanged (${size})`);
}
eq(Shim.isEncoding('base64url'), true, 'isEncoding base64url');
eq(Shim.isEncoding('nope'), false, 'isEncoding nope');
eq(Shim.from('héllo').toString(), 'héllo', 'utf8 unchanged');
eq(Shim.alloc(4, 'AQI', 'base64url'), Buffer.alloc(4, 'AQI', 'base64url'), 'alloc with base64url fill');

console.log(`BUFFER SHIM PASS (${checks} checks)`);
