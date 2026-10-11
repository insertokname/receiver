// SPDX-License-Identifier: AGPL-3.0-only
//
// Runs libsignal's own TypeScript test suite (libsignal/node/ts/test,
// compiled by build.sh) in Node against the WebAssembly build.
//
// Usage: node test/node.mjs [mocha --grep pattern]

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import Mocha from 'mocha';

const PACKAGE = fileURLToPath(new URL('../dist/package/', import.meta.url));
const TESTS = join(PACKAGE, 'dist/test');

// Test files that are not run, and why. Everything else in the suite is.
const SKIPPED = {
  'NetTest.js': 'libsignal-net is not part of the web build',
  'RegistrationTest.js': 'libsignal-net (registration service)',
  'KeyTransparencyTest.js': 'libsignal-net (key transparency client)',
  'Cds2Test.js': 'libsignal-net / attest (CDSI enclave handshake)',
  'Svr2Test.js': 'libsignal-net / attest (SVR2 enclave handshake)',
  'SvrBTest.js': 'libsignal-net (SVR-B)',
  'HsmEnclaveTest.js': 'libsignal-net / attest (HSM enclave)',
  'chat/': 'libsignal-net (chat services)',
  'BridgingTest.js':
    'creates a TokioAsyncContext while loading; its bridging checks run in a copy without the async-runtime suites (see below)',
  'MinidumpTest.js': 'crash dump processing is not part of the web build (Electron main process only)',
};

// Individual tests (by full title) that are skipped, and why.
const SKIPPED_TESTS = {
  'TokioAsyncContext supports cancellation of running future':
    "TokioAsyncContext is libsignal-net's async runtime, not in the web build",
  'TokioAsyncContext supports pre-cancellation of not-yet-running future':
    "TokioAsyncContext is libsignal-net's async runtime, not in the web build",
  'PinHash fromUsernameMrenclave produces the same keys as fromSalt with the derived salt':
    'needs attest (SVR2 enclave table), which is not part of the web build; the PIN is not used by Desktop',
};

function isSkipped(file) {
  const rel = relative(TESTS, file);
  return Object.keys(SKIPPED).some(s => (s.endsWith('/') ? rel.startsWith(s) : rel === s));
}

async function listTests(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listTests(path)));
    else if (/(Test|-test|ServerAPI)\.js$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

const { initLibsignal } = await import(join(PACKAGE, 'wasm/index.js'));
await initLibsignal({ wasm: await readFile(join(PACKAGE, 'wasm/libsignal_node.wasm')) });

const mocha = new Mocha({ timeout: 20000, grep: process.argv[2] });
for (const file of await listTests(TESTS)) {
  if (!isSkipped(file)) mocha.addFile(file);
}
mocha.addFile(fileURLToPath(new URL('./bridging.mjs', import.meta.url)));
mocha.suite.beforeEach(function () {
  const reason = SKIPPED_TESTS[this.currentTest.fullTitle()];
  if (reason) this.skip();
});

console.log('Skipped test files:');
for (const [file, reason] of Object.entries(SKIPPED)) console.log(`  ${file}: ${reason}`);
console.log('Skipped tests:');
for (const [test, reason] of Object.entries(SKIPPED_TESTS)) console.log(`  ${test}: ${reason}`);

await mocha.loadFilesAsync();
// Like mocha --exit: pending emnapi handles must not keep the run alive.
mocha.run(failures => process.exit(failures ? 1 : 0));
