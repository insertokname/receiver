// SPDX-License-Identifier: AGPL-3.0-only
//
// The renderer's node:fs on the origin private file system, in headless
// Chromium under the app's CSP (renderer/test/fs-page.ts has the checks).
// Run: node renderer/test/fs-shim.mjs (needs web/dist/site and $CHROMIUM).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

import { BASE_PATH, LOCAL_ORIGIN, SITE_DIR, launchBrowser, serveSite, watchPage } from '../../scripts/harness.mjs';
import { webResolvePlugin } from '../resolve.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '../../..');

const appHtml = await readFile(join(SITE_DIR, 'index.html'), 'utf8');
const csp = appHtml.match(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/)?.[0];
if (!csp) throw new Error('index.html has no CSP meta tag');

const bundle = await build({
  cwd: REPO,
  input: join(HERE, 'fs-page.ts'),
  platform: 'browser',
  tsconfig: join(REPO, 'tsconfig.json'),
  write: false,
  transform: {
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
    inject: {
      process: 'node:process',
      Buffer: ['node:buffer', 'Buffer'],
      setImmediate: ['node:timers', 'setImmediate'],
      clearImmediate: ['node:timers', 'clearImmediate'],
    },
  },
  plugins: [webResolvePlugin().plugin],
  output: { format: 'esm', codeSplitting: false },
});

const server = await serveSite({
  extra: {
    [`${BASE_PATH}fs-test.html`]: [
      'text/html; charset=utf-8',
      `<!doctype html><html><head><meta charset="utf-8">${csp}<title>fs test</title><script type="module" src="./fs-test.js"></script></head><body></body></html>`,
    ],
    [`${BASE_PATH}fs-test.js`]: ['text/javascript', bundle.output[0].code],
  },
});
const browser = await launchBrowser();
let ok = false;
try {
  const page = await browser.newPage();
  const watcher = await watchPage(page);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${LOCAL_ORIGIN}${BASE_PATH}fs-test.html`);
  await page.waitForFunction(() => window.fsResults, { timeout: 60_000 });
  const results = await page.evaluate(() => window.fsResults);
  for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
  const problems = await watcher.report();
  problems.push(...errors.map(e => `uncaught exception: ${e}`));
  problems.push(...results.filter(r => !r.ok).map(r => r.name));
  for (const p of problems) console.log(`FS FAIL: ${p}`);
  ok = problems.length === 0;
  console.log(ok ? `FS PASS (${results.length} checks)` : 'FS FAIL');
} catch (error) {
  console.log(`FS FAIL: ${error.stack ?? error.message}`);
} finally {
  await browser.close();
  server.close();
}
process.exit(ok ? 0 : 1);
