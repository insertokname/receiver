// SPDX-License-Identifier: AGPL-3.0-only
//
// Smoke test for the start page: it must reach "provisioning address
// received" (<html data-state="provisioned">), i.e. Tor bootstrapped and
// Signal's provisioning socket pushed an address through it.
//
//   node app/smoke.mjs                      serve web/dist/site under /receiver/
//   node app/smoke.mjs https://insertokname.github.io/receiver/
//   BLACKHOLE=snowflake.torproject.net      make that host unreachable
//   SMOKE_TIMEOUT_SECS=<n>                  give up after n seconds (default 300)
//
// Also fails if the page contacts any host directly other than its own origin
// and the Tor entry points, or triggers a CSP violation.
//
// Needs: CHROMIUM=<browser executable>.

import { BASE_PATH, LOCAL_ORIGIN, launchBrowser, pipePageOutput, serveSite, watchPage } from '../scripts/harness.mjs';

const target = process.argv[2];
const blackholeHosts = (process.env.BLACKHOLE ?? '').split(',').filter(Boolean);
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_SECS ?? 300) * 1000;

const server = target ? null : await serveSite();
const browser = await launchBrowser({ blackholeHosts });
const started = Date.now();
let ok = false;
try {
  const page = await browser.newPage();
  pipePageOutput(page);
  const watcher = await watchPage(page);
  const url = target ?? `${LOCAL_ORIGIN}${BASE_PATH}`;
  console.log(`smoke test: ${url}${blackholeHosts.length ? ` (unreachable: ${blackholeHosts.join(', ')})` : ''}`);
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new Error(`page load failed: HTTP ${response?.status()}`);

  let lastState;
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    const { state, status } = await page.evaluate(() => ({
      state: document.documentElement.dataset.state,
      status: document.getElementById('status')?.textContent,
    }));
    if (state !== lastState) {
      console.log(`[smoke ${((Date.now() - started) / 1000).toFixed(1)}s] state=${state}: ${status}`);
      lastState = state;
    }
    if (state === 'provisioned') {
      ok = true;
      break;
    }
    if (state === 'error') break;
    await new Promise(r => setTimeout(r, 500));
  }
  const transport = await page.evaluate(() => document.getElementById('transport')?.textContent);
  const problems = await watcher.report();
  for (const p of problems) console.log(`SMOKE FAIL: ${p}`);
  if (problems.length) ok = false;
  console.log(ok
    ? `SMOKE PASS in ${((Date.now() - started) / 1000).toFixed(1)}s: ${transport}`
    : `SMOKE FAIL: did not reach "provisioned" within ${timeoutMs / 1000}s (last state: ${lastState})`);
} catch (e) {
  console.log(`SMOKE FAIL: ${e.message}`);
} finally {
  await browser.close();
  server?.close();
}
if (!ok && process.env.GITHUB_ACTIONS) {
  console.log(`::error title=Smoke test failed::${target ?? 'local site'} did not reach "provisioning address received"`);
}
process.exit(ok ? 0 : 1);
