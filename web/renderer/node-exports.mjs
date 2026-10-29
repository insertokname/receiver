// SPDX-License-Identifier: AGPL-3.0-only
//
// Writes renderer/node-exports.json: the export names of the Node builtins
// the browser build stubs (resolve.mjs STUBBED_BUILTINS), taken from the
// Node running this script. The build reads the file instead of asking its
// own Node, so the bundle does not change with the Node build.
//
// Usage: node renderer/node-exports.mjs

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STUBBED_BUILTINS } from './resolve.mjs';

const exports = {};
for (const name of STUBBED_BUILTINS) {
  // eslint-disable-next-line no-await-in-loop
  const real = await import(`node:${name}`);
  exports[name] = Object.keys(real)
    .filter(k => k !== 'default' && /^[A-Za-z_$][\w$]*$/.test(k))
    .sort();
}
const out = fileURLToPath(new URL('node-exports.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(exports, null, 2)}\n`);
console.log(`${out}: ${STUBBED_BUILTINS.length} modules (node ${process.version})`);
