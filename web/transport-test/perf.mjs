// SPDX-License-Identifier: AGPL-3.0-only
//
// Transport measurements over real Snowflake/Tor (transport-test/perf.js),
// a fresh browser profile per run, and a summary (median [min - max]) at
// the end. Real Tor is noisy: these numbers are for reports and for
// comparing builds run back to back, not for pass/fail thresholds. The
// page only exists here (it is not part of the site); it uses the site's
// transport and only Signal's hosts (no account).
//
//   node transport-test/perf.mjs                 3 runs in Chromium
//   RUNS=5 SIZE_MB=32 node transport-test/perf.mjs
//   HIDDEN=1 node transport-test/perf.mjs        also with the page hidden
//   MODES=single node transport-test/perf.mjs    only the single-stream download
//   APP=1 node transport-test/perf.mjs           the app instead: page load to
//                                                Tor ready and to the link QR
//                                                code, cold and after a reload
//   BROWSER=firefox FIREFOX=<firefox> node ...   in Firefox
//   CC=0 node ...                                circuits with Tor's fixed window
//                                                instead of congestion control
//   SITE=<dir> node ...                          another build of the site
//   PERF_OUT=<file>                              append each run's JSON
//
// Needs: web/scripts/build-site.sh output, CHROMIUM=<browser executable>.

import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BASE_PATH, LOCAL_ORIGIN, SITE_DIR, launchBrowser, serveSite, watchPage } from '../scripts/harness.mjs';

const RUNS = Number(process.env.RUNS ?? 3);
const APP = Boolean(process.env.APP);
const HIDDEN = Boolean(process.env.HIDDEN);
const query = new URLSearchParams({
  sizeMB: process.env.SIZE_MB ?? '16',
  modes: process.env.MODES ?? 'single,parallel',
  lanes: process.env.LANES ?? '4',
});
if (HIDDEN) query.set('hidden', '');
if (process.env.CC === '0') query.set('cc', '0');
const siteDir = process.env.SITE ? resolve(process.env.SITE) + '/' : SITE_DIR;
const label = process.env.LABEL ?? (process.env.BROWSER === 'firefox' ? 'firefox' : 'chromium');

const here = new URL('./', import.meta.url);
const extra = {
  [`${BASE_PATH}test/perf.html`]: ['text/html; charset=utf-8', readFileSync(new URL('perf.html', here))],
  [`${BASE_PATH}test/perf.js`]: ['text/javascript', readFileSync(new URL('perf.js', here))],
};

// Chromium (through puppeteer) does not throttle hidden pages unless these
// default flags are dropped.
const UNTHROTTLED = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

const INSTALL_QR = '.module-InstallScreenQrCodeNotScannedStep__qr-code--loaded svg';

async function measureApp(browser, page) {
  const boot = async () => {
    const tor = await page.waitForFunction(() => document.documentElement.dataset.tor === 'ready' && performance.now(), {
      timeout: 180_000,
      polling: 100,
    });
    const torSeconds = (await tor.jsonValue()) / 1000;
    const qr = await page.waitForFunction(sel => document.querySelector(sel) && performance.now(), { timeout: 180_000, polling: 100 }, INSTALL_QR);
    return { torReady: Math.round(torSeconds * 100) / 100, qr: Math.round(((await qr.jsonValue()) / 1000) * 100) / 100 };
  };
  await page.goto(`${LOCAL_ORIGIN}${BASE_PATH}`);
  const cold = await boot();
  // Let the service worker finish installing, so the reload is served by it.
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 60_000, polling: 500 }).catch(() => undefined);
  await page.reload();
  const warm = await boot();
  return { app: { cold, warm } };
}

async function measureTransport(browser, page) {
  page.on('console', async message => {
    if (message.text() !== 'ACTION hide') return;
    const other = await browser.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
  });
  await page.goto(`${LOCAL_ORIGIN}${BASE_PATH}test/perf.html?${query}`);
  const handle = await page.waitForFunction(() => window.__perf, { timeout: 25 * 60_000, polling: 1000 });
  return handle.jsonValue();
}

const server = await serveSite({ extra, siteDir });
const results = [];
let problems = 0;
try {
  for (let run = 1; run <= RUNS; run++) {
    console.log(`--- run ${run}/${RUNS} (${label}${APP ? ', app' : ''}) ---`);
    const browser = await launchBrowser(HIDDEN ? { ignoreDefaultArgs: UNTHROTTLED } : {});
    try {
      const page = await browser.newPage();
      page.on('console', m => {
        const text = m.text();
        if (!APP && text.startsWith('[')) console.log(`  ${text.slice(0, 300)}`);
      });
      const watcher = await watchPage(page);
      const result = APP ? await measureApp(browser, page) : await measureTransport(browser, page);
      for (const problem of await watcher.report()) {
        console.log(`PROBLEM ${problem}`);
        problems++;
      }
      result.label = label;
      result.run = run;
      result.at = new Date().toISOString();
      results.push(result);
      if (process.env.PERF_OUT) appendFileSync(process.env.PERF_OUT, JSON.stringify(result) + '\n');
      if (result.errors?.length) console.log(`  errors: ${result.errors.join(' | ')}`);
    } catch (error) {
      console.log(`run ${run} failed: ${error?.message ?? error}`);
      problems++;
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
} finally {
  server.close();
}

const median = values => {
  const sorted = values.filter(v => typeof v === 'number').sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const max = values => Math.max(...values.filter(v => typeof v === 'number'));

// metric name -> one value per run
const metrics = new Map();
const add = (name, value) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return;
  if (!metrics.has(name)) metrics.set(name, []);
  metrics.get(name).push(value);
};
for (const r of results) {
  if (r.app) {
    for (const phase of ['cold', 'warm']) {
      add(`app ${phase}: Tor ready (s)`, r.app[phase].torReady);
      add(`app ${phase}: link QR code (s)`, r.app[phase].qr);
    }
    continue;
  }
  add('wasm load (s)', r.wasmLoad);
  add('bootstrap (s)', r.bootstrap?.seconds);
  for (const [stage, at] of Object.entries(r.bootstrap?.stages ?? {})) add(`  stage ${stage} at (s)`, at);
  add('chat connect (s, median of 3)', median(r.chatConnect ?? []));
  add('chat round trip idle (s, median)', median(r.rttIdle ?? []));
  add('https time to head, new connection (s)', median(r.httpsNew ?? []));
  add('https time to head, reused (s)', median(r.httpsReused ?? []));
  for (const [prefix, downloads] of [['', r.downloads ?? []], ['hidden ', r.hidden?.downloads ?? []]]) {
    for (const d of downloads) {
      add(`${prefix}${d.mode} download MB/s`, d.MBps);
      add(`${prefix}${d.mode} download steady MB/s`, d.steadyMBps);
      add(`${prefix}${d.mode} download time to head (s)`, d.ttfb);
      add(`${prefix}${d.mode}: chat round trip meanwhile (s, median)`, median(d.chatRtts));
      add(`${prefix}${d.mode}: chat round trip meanwhile (s, max)`, max(d.chatRtts));
    }
  }
  if (r.hidden) add('hidden: chat round trip idle (s, median)', median(r.hidden.rttIdle));
  if (r.circuits) {
    add('circuit build (s, median)', median(r.circuits.buildTimesMs.map(ms => ms / 1000)));
    add('circuit builds given up', r.circuits.abandonedBuilds);
  }
}

console.log(`\n=== SUMMARY (${label}, ${results.length} of ${RUNS} runs${APP ? ', app' : `, ${query.get('sizeMB')} MB`}) ===`);
for (const [name, values] of metrics) {
  const fmt = v => (Math.round(v * 1000) / 1000).toString();
  console.log(`${name.padEnd(52)} ${fmt(median(values)).padStart(8)}  [${fmt(Math.min(...values))} - ${fmt(Math.max(...values))}]  n=${values.length}`);
}
const errors = results.flatMap(r => r.errors ?? []);
if (errors.length) console.log(`errors (${errors.length}): ${errors.join(' | ')}`);
process.exit(problems || results.length === 0 ? 1 : 0);
