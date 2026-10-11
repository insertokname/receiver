// SPDX-License-Identifier: AGPL-3.0-only
//
// libsignal checks page: instantiate the WebAssembly build first, then load
// the code that imports @signalapp/libsignal-client.

import { initLibsignal } from '@signalapp/libsignal-client/wasm/index.js';

const out = document.getElementById('out');
const log = line => {
  out.textContent += `${line}\n`;
  console.log(line);
};

try {
  const started = performance.now();
  await initLibsignal();
  log(`ok   libsignal WebAssembly loaded (${Math.round(performance.now() - started)} ms)`);
  const { runChecks } = await import('./checks.js');
  await runChecks(log);
  log('PASS all checks');
  document.documentElement.dataset.state = 'passed';
} catch (error) {
  log(`FAIL ${error?.stack ?? error}`);
  document.documentElement.dataset.state = 'failed';
}
