// SPDX-License-Identifier: AGPL-3.0-only
//
// Runs the libsignal checks page (web/dist/site/libsignal/) in headless
// Chromium: libsignal's WebAssembly under the site's strict CSP, a PQXDH
// session with async in-memory stores, sealed sender and zkgroup.
//
//   node libsignal/check/run.mjs                 serve web/dist/site under /receiver/
//   node libsignal/check/run.mjs https://insertokname.github.io/receiver/
//
// Fails on any check failure, CSP violation or direct network destination
// other than the page's origin. Needs: CHROMIUM=<browser executable>.

import { BASE_PATH, LOCAL_ORIGIN, launchBrowser, pipePageOutput, serveSite, watchPage } from '../../scripts/harness.mjs';

const target = process.argv[2];
const server = target ? null : await serveSite();
const browser = await launchBrowser();
let ok = false;
try {
  const page = await browser.newPage();
  pipePageOutput(page);
  const watcher = await watchPage(page);
  const url = new URL('libsignal/', target ?? `${LOCAL_ORIGIN}${BASE_PATH}`).href;
  console.log(`libsignal checks: ${url}`);
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new Error(`page load failed: HTTP ${response?.status()}`);
  await page.waitForFunction(() => document.documentElement.dataset.state !== 'loading', { timeout: 120_000 });
  const state = await page.evaluate(() => document.documentElement.dataset.state);
  const problems = await watcher.report();
  for (const p of problems) console.log(`LIBSIGNAL FAIL: ${p}`);
  ok = state === 'passed' && problems.length === 0;
  console.log(ok ? 'LIBSIGNAL PASS' : `LIBSIGNAL FAIL: page state ${state}`);
} catch (e) {
  console.log(`LIBSIGNAL FAIL: ${e.message}`);
} finally {
  await browser.close();
  server?.close();
}
if (!ok && process.env.GITHUB_ACTIONS) {
  console.log('::error title=libsignal checks failed::the libsignal checks page did not pass');
}
process.exit(ok ? 0 : 1);
