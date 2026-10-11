// SPDX-License-Identifier: AGPL-3.0-only
//
// Verifies a Tor directory snapshot (consensus.txt.br, certs.txt.br,
// microdescriptors.txt.br in DIR) with the transport's own WebAssembly
// (webtor's verifyTorDirectory, the code the client runs before using a
// directory): authority certificates against the pinned authority
// identities, consensus signatures and lifetime, microdescriptor digests.
// Also requires a microdescriptor for at least 95% of the relays, none that
// does not match, and a consensus fetched within the last day.
//
// Usage: node transport/verify-directory.mjs DIR [--wasm PATH]
// Exit status 1 when the snapshot does not verify.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

const HERE = new URL('.', import.meta.url).pathname;
const MIN_MICRODESC_PERCENT = 95;
// Clients accept a consensus up to 3 days after valid-until (Tor's
// tolerance); a snapshot older than a day at build time is a fetch problem.
const MAX_AGE_HOURS = 24;

const args = process.argv.slice(2);
const dir = args[0];
const wasmIndex = args.indexOf('--wasm');
const wasmPath = wasmIndex >= 0 ? args[wasmIndex + 1] : join(HERE, 'dist/pkg/webtor_wasm_bg.wasm');
if (!dir) {
  console.error('usage: node transport/verify-directory.mjs DIR [--wasm PATH]');
  process.exit(2);
}

const { initSync, verifyTorDirectory } = await import(
  new URL('webtor_wasm.js', new URL(`file://${wasmPath}`)).href
);
initSync({ module: readFileSync(wasmPath) });

const read = name => brotliDecompressSync(readFileSync(join(dir, `${name}.txt.br`))).toString('utf8');
const started = performance.now();
let summary;
try {
  summary = verifyTorDirectory(read('consensus'), read('certs'), read('microdescriptors'), Date.now());
} catch (error) {
  console.error(`Tor directory snapshot refused: ${error}`);
  process.exit(1);
}
const seconds = ((performance.now() - started) / 1000).toFixed(2);
const iso = ms => new Date(ms).toISOString();
console.log(
  `Tor directory verified in ${seconds} s: ${summary.relays} relays in the consensus, ` +
    `${summary.microdescriptors} microdescriptors (${summary.droppedMicrodescriptors} dropped), ` +
    `${summary.usableRelays} usable relays, ${summary.certificates} authority certificates, ` +
    `valid ${iso(summary.validAfter)} .. ${iso(summary.validUntil)}`
);
const failures = [];
if (summary.microdescriptors * 100 < summary.relays * MIN_MICRODESC_PERCENT) {
  failures.push(`only ${summary.microdescriptors} microdescriptors for ${summary.relays} relays`);
}
// The client drops a microdescriptor that does not match the consensus; in a
// freshly fetched snapshot there should be none.
if (summary.droppedMicrodescriptors > 0) {
  failures.push(`${summary.droppedMicrodescriptors} microdescriptors do not match the consensus`);
}
const ageHours = (Date.now() - summary.validAfter) / 3.6e6;
if (ageHours > MAX_AGE_HOURS) failures.push(`consensus is ${ageHours.toFixed(0)} h old`);
if (failures.length > 0) {
  console.error(`Tor directory snapshot refused: ${failures.join('; ')}`);
  process.exit(1);
}
