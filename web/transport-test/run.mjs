// SPDX-License-Identifier: AGPL-3.0-only
//
// Runs the transport checks page (web/dist/site/test/) in headless Chromium
// and exits non-zero if any check fails.
//
//   node transport-test/run.mjs [query]             e.g. 'suites=ws&only=basic,bulk'
//   node transport-test/run.mjs 'only=directory'    Tor directory verification (no network)
//   BLACKHOLE=snowflake.torproject.net node ...     make that host unreachable
//   LIVENESS=1 node transport-test/run.mjs 'only=liveness'
//                                    the bridge is reached through a local
//                                    proxy that black-holes it when the page asks
//   BROWSER=firefox FIREFOX=<firefox> node ...      in Firefox
//
// Needs: web/scripts/build-site.sh output, CHROMIUM=<browser executable>.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

import { BASE_PATH, LOCAL_ORIGIN, SITE_DIR, launchBrowser, pipePageOutput, serveSite, watchPage } from '../scripts/harness.mjs';
import { startTunnelProxy } from '../scripts/tunnel-proxy.mjs';

const query = process.argv[2] ?? 'suites=ws';
const blackholeHosts = (process.env.BLACKHOLE ?? '').split(',').filter(Boolean);
const timeoutMs = Number(process.env.TEST_TIMEOUT_SECS ?? 60 * 60) * 1000;

// For the directory checks (only=directory): the site's snapshot as plain
// text, which the page tampers with, and the certificates of Arti's test
// network (authorities that are not the pinned ones). Test-only routes.
const extra = {};
if (new URLSearchParams(query).get('only')?.split(',').includes('directory')) {
  const plain = `${BASE_PATH}test/tor-plain/`;
  for (const name of ['consensus', 'certs', 'microdescriptors']) {
    const body = brotliDecompressSync(readFileSync(join(SITE_DIR, `transport/tor/${name}.txt.br`)));
    extra[`${plain}${name}.txt`] = ['text/plain; charset=utf-8', body];
  }
  const testdata = new URL('../transport/webtor-rs/vendor/arti/crates/tor-dirmgr/testdata/', import.meta.url);
  const otherCerts = ['cert-5696.txt', 'cert-5A23.txt', 'cert-7C47.txt'].map(n => readFileSync(new URL(n, testdata)));
  extra[`${plain}other-network-certs.txt`] = ['text/plain; charset=utf-8', Buffer.concat(otherCerts)];
}

const server = await serveSite({ extra });
const proxy = process.env.LIVENESS ? await startTunnelProxy() : undefined;
const browser = await launchBrowser({ blackholeHosts, proxyPort: proxy?.port });
let failed = true;
try {
  const page = await browser.newPage();
  pipePageOutput(page);
  const watcher = await watchPage(page);
  page.on('console', message => {
    if (message.text() !== 'ACTION blackhole') return;
    if (!proxy) return;
    proxy.blackholeAll();
    console.log(`proxy: ${proxy.stats.blackholed} tunnel(s) black-holed`);
    page.evaluate(() => {
      window.__blackholed = true;
    }).catch(() => undefined);
  });
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
  await proxy?.close();
}
process.exit(failed ? 1 : 0);
