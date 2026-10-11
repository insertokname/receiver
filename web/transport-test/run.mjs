// SPDX-License-Identifier: AGPL-3.0-only
//
// Runs the transport checks page (web/dist/site/test/) in headless Chromium
// and exits non-zero if any check fails.
//
//   node transport-test/run.mjs [query]             e.g. 'suites=ws&only=basic,bulk'
//   BLACKHOLE=snowflake.torproject.net node ...     make that host unreachable
//
// Needs: web/scripts/build-site.sh output, CHROMIUM=<browser executable>.

import { BASE_PATH, LOCAL_ORIGIN, launchBrowser, pipePageOutput, serveSite, watchPage } from '../scripts/harness.mjs';

const query = process.argv[2] ?? 'suites=ws';
const blackholeHosts = (process.env.BLACKHOLE ?? '').split(',').filter(Boolean);
const timeoutMs = Number(process.env.TEST_TIMEOUT_SECS ?? 60 * 60) * 1000;

const server = await serveSite();
const browser = await launchBrowser({ blackholeHosts });
let failed = true;
try {
  const page = await browser.newPage();
  pipePageOutput(page);
  const watcher = await watchPage(page);
  if (blackholeHosts.length) console.log(`unreachable for this run: ${blackholeHosts.join(', ')}`);
  await page.goto(`${LOCAL_ORIGIN}${BASE_PATH}test/?autorun&${query}`);
  const results = await page
    .waitForFunction(() => window.__done, { timeout: timeoutMs, polling: 1000 })
    .then(h => h.jsonValue());
  console.log('\n=== SUMMARY ===');
  for (const r of results) {
    const secs = r.seconds != null ? `${r.seconds.toFixed(2).padStart(6)}s` : '       ';
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${secs}  ${r.name}  (${r.detail})`);
  }
  const problems = await watcher.report();
  for (const p of problems) console.log(`FAIL  ${p}`);
  failed = results.length === 0 || results.some(r => !r.ok) || problems.length > 0;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
