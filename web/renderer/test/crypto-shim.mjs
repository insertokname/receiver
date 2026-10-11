// SPDX-License-Identifier: AGPL-3.0-only
//
// Differential test of the node:crypto shim (shims/node/crypto.ts) against
// Node's own node:crypto: same output for the hashes, HMAC and AES modes
// Desktop uses, fed in randomly sized chunks. Run: node renderer/test/crypto-shim.mjs

import * as node from 'node:crypto';
import * as shim from '../shims/node/crypto.ts';

let checks = 0;
const eq = (a, b, what) => {
  checks += 1;
  if (Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0) {
    throw new Error(`mismatch: ${what}`);
  }
};
const chunks = data => {
  const out = [];
  for (let i = 0; i < data.length; ) {
    const n = node.randomInt(0, 70);
    out.push(data.subarray(i, i + n));
    i += n;
  }
  return out;
};
const run = (impl, factory, data) => {
  const c = factory(impl);
  const parts = chunks(data).map(p => c.update(p));
  parts.push(c.final());
  return { out: Buffer.concat(parts.map(p => Buffer.from(p))), c };
};

for (const size of [0, 1, 15, 16, 17, 31, 32, 33, 1000, 4096, 65537]) {
  const data = node.randomBytes(size);
  const key = node.randomBytes(32);
  for (const alg of ['sha256', 'sha512', 'sha1', 'md5']) {
    const h = shim.createHash(alg);
    chunks(data).forEach(p => h.update(p));
    eq(h.digest(), node.createHash(alg).update(data).digest(), `${alg} ${size}`);
    const m = shim.createHmac(alg, key);
    chunks(data).forEach(p => m.update(p));
    eq(m.digest(), node.createHmac(alg, key).update(data).digest(), `hmac-${alg} ${size}`);
  }
  for (const alg of ['aes-256-cbc', 'aes-256-ctr']) {
    const iv = node.randomBytes(16);
    if (alg === 'aes-256-ctr') iv.fill(0xff, 8); // exercise the 128-bit carry
    const enc = run(shim, i => i.createCipheriv(alg, key, iv), data).out;
    eq(enc, run(node, i => i.createCipheriv(alg, key, iv), data).out, `${alg} enc ${size}`);
    eq(run(shim, i => i.createDecipheriv(alg, key, iv), enc).out, data, `${alg} dec ${size}`);
    if (alg === 'aes-256-cbc' && size % 16 === 0) {
      const raw = run(node, i => i.createCipheriv(alg, key, iv).setAutoPadding(false), data).out;
      eq(run(shim, i => i.createCipheriv(alg, key, iv).setAutoPadding(false), data).out, raw, `cbc nopad enc ${size}`);
      eq(run(shim, i => i.createDecipheriv(alg, key, iv).setAutoPadding(false), raw).out, data, `cbc nopad dec ${size}`);
    }
  }
  const nonce = node.randomBytes(12);
  const { out: sealed, c } = run(shim, i => i.createCipheriv('aes-256-gcm', key, nonce), data);
  const ref = run(node, i => i.createCipheriv('aes-256-gcm', key, nonce), data);
  eq(sealed, ref.out, `gcm enc ${size}`);
  eq(c.getAuthTag(), ref.c.getAuthTag(), `gcm tag ${size}`);
  eq(run(shim, i => i.createDecipheriv('aes-256-gcm', key, nonce).setAuthTag(ref.c.getAuthTag()), sealed).out, data, `gcm dec ${size}`);
  const bad = Buffer.from(ref.c.getAuthTag());
  bad[0] ^= 1;
  let rejected = false;
  try {
    run(shim, i => i.createDecipheriv('aes-256-gcm', key, nonce).setAuthTag(bad), sealed);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('gcm accepted a bad tag');
  checks += 1;
}
let badPad = false;
try {
  const key = node.randomBytes(32);
  const iv = node.randomBytes(16);
  run(shim, i => i.createDecipheriv('aes-256-cbc', key, iv), node.randomBytes(32));
} catch {
  badPad = true;
}
checks += 1;
if (!badPad) console.log('note: random CBC ciphertext happened to unpad (1/256 chance)');
const values = new Set(Array.from({ length: 2000 }, () => shim.randomInt(3, 10)));
if (Math.min(...values) !== 3 || Math.max(...values) !== 9) throw new Error('randomInt range');
if (!shim.timingSafeEqual(Buffer.from('ab'), Buffer.from('ab')) || shim.timingSafeEqual(Buffer.from('ab'), Buffer.from('ac'))) {
  throw new Error('timingSafeEqual');
}
console.log(`crypto shim: ${checks + 2} checks passed`);
