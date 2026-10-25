// SPDX-License-Identifier: AGPL-3.0-only
//
// The service worker (web/sw) in headless Chromium, against copies of the
// built site (web/dist/site) served like GitHub Pages:
//
//   1. first load: the worker installs and stores the app's core files;
//   2. second load: the app's code comes from the worker's cache (the
//      server sees no request for it);
//   3. offline (server stopped, browser offline): the app still loads from the cache and
//      shows its "not connected" state, not the browser's error page;
//   4. a redeployment that only changes the Tor directory snapshot: no
//      update is offered, the new snapshot is fetched;
//   5. a redeployment with changed code (a new sw.js): "A new version of
//      receiver is available" appears, the running version keeps being
//      served (also after a reload, and after a hard reload: the page loads
//      again through the worker) until the user clicks it; then the new
//      version is served.
//
// Also checks the web app manifest (what Chromium needs to offer installing
// the app). Fails on CSP violations, uncaught exceptions and network
// destinations other than the page's origin and the Tor entry points.
//
//   node sw/test/run.mjs           (needs web/dist/site and $CHROMIUM)

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE_PATH, LOCAL_ORIGIN, SITE_DIR, launchBrowser, serveSite, watchPage } from '../../scripts/harness.mjs';
import { buildServiceWorker } from '../build.mjs';

const WEB = fileURLToPath(new URL('../..', import.meta.url));
const WORK = join(WEB, 'dist/sw-test');
const VERSIONS = { a: join(WORK, 'a/'), b: join(WORK, 'b/'), c: join(WORK, 'c/') };
const MARKER = '/* receiver service worker test: version c */';
const appUrl = `${LOCAL_ORIGIN}${BASE_PATH}`;

// Version a: the site as built. b: the same code, another Tor directory
// file (same snapshot, compressed differently). c: changed code, its own sw.js.
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
for (const dir of Object.values(VERSIONS)) await cp(SITE_DIR, dir, { recursive: true });
{
  const consensus = join(VERSIONS.b, 'transport/tor/consensus.txt.br');
  const text = execFileSync('brotli', ['-dc', consensus], { maxBuffer: 1 << 30 });
  await writeFile(consensus, execFileSync('brotli', ['-c', '-q', '5'], { input: text, maxBuffer: 1 << 30 }));
  await writeFile(join(VERSIONS.c, 'shell.css'), `${await readFile(join(VERSIONS.c, 'shell.css'), 'utf8')}\n${MARKER}\n`);
  await rm(join(VERSIONS.c, 'sw.js'));
  // Built over the whole site (check pages included): another file list,
  // so another build, as a real code change would give.
  await buildServiceWorker(VERSIONS.c);
}

let version = 'a';
const requests = [];
let server;
const start = async () => {
  server = await serveSite({ siteDir: () => VERSIONS[version], onRequest: path => requests.push(path) });
};
const stop = () =>
  new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  });
await start();

const browser = await launchBrowser();
const problems = [];
const results = [];
const pageErrors = [];
let ok = false;

function check(name, condition, detail) {
  results.push(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!condition) problems.push(`${name}${detail ? `: ${detail}` : ''}`);
}

try {
  const page = await browser.newPage();
  const watcher = await watchPage(page);
  page.on('pageerror', e => {
    pageErrors.push(e.message);
    console.log(`  PAGEERROR ${e.stack ?? e.message}`);
  });
  page.on('console', m => {
    const text = m.text();
    if (/service worker|web shell|web boot: .*failed/.test(text)) console.log(`  | ${text.slice(0, 200)}`);
  });
  const status = () => page.evaluate(() => window.__webServiceWorker ?? null);
  const shellCss = () => page.evaluate(async () => (await fetch('shell.css')).text());
  const waitFor = (fn, what, timeout = 60_000, ...args) =>
    page.waitForFunction(fn, { timeout, polling: 200 }, ...args).catch(() => {
      throw new Error(`timed out waiting for ${what}`);
    });
  const load = async () => {
    const response = await page.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(() => ['startApp', 'database-error', 'failed'].includes(document.documentElement.dataset.boot), 'the app to start');
    return response;
  };

  // 1. First load: the worker installs.
  let started = Date.now();
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await waitFor(
    () => navigator.serviceWorker.controller != null && window.__webServiceWorker?.status?.approved === window.__webServiceWorker?.status?.build,
    'the service worker to install and control the page',
    120_000
  );
  const first = await status();
  check('service worker registered and installed', first?.registered === true, `build ${first?.status?.build.slice(0, 12)} in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  // The web app manifest, as Chromium's installability check reads it.
  const cdp = await page.createCDPSession();
  const manifest = await cdp.send('Page.getAppManifest');
  const parsed = manifest.data ? JSON.parse(manifest.data) : {};
  check(
    'web app manifest',
    manifest.errors.length === 0 && parsed.name === 'receiver' && parsed.display === 'standalone' &&
      parsed.icons?.some(i => i.sizes === '512x512' && i.type === 'image/png') && parsed.icons?.some(i => i.sizes === '192x192'),
    `${manifest.url.replace(LOCAL_ORIGIN, '')}, ${manifest.errors.length} errors${manifest.errors.length ? ` (${manifest.errors.map(e => e.message).join('; ')})` : ''}`
  );
  const installability = await cdp.send('Page.getInstallabilityErrors').catch(error => ({ error: error.message }));
  check(
    'installable (Chromium)',
    Array.isArray(installability.installabilityErrors) && installability.installabilityErrors.length === 0,
    JSON.stringify(installability.installabilityErrors ?? installability.error)
  );

  // 2. Second load: from the cache. First the first load and the worker's
  // caching of what it loaded finish (the server hears nothing for 2 s).
  for (let seen = -1, quietSince = Date.now(); Date.now() - quietSince < 2000; ) {
    if (requests.length !== seen) [seen, quietSince] = [requests.length, Date.now()];
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  requests.length = 0;
  started = Date.now();
  const fromWorker = [];
  const onResponse = r => {
    if (/\/(app\.js|index\.html|chunks\/[^/]+\.js|sql\/worker\.js|[^/]+\.wasm)$|\/receiver\/$/.test(new URL(r.url()).pathname)) {
      fromWorker.push([new URL(r.url()).pathname, r.fromServiceWorker()]);
    }
  };
  page.on('response', onResponse);
  await load();
  page.off('response', onResponse);
  const codeRequests = requests.filter(p => !p.includes('/transport/tor/') && !p.endsWith('/sw.js'));
  check(
    'second load from the cache',
    fromWorker.length > 0 && fromWorker.every(([, worker]) => worker) && codeRequests.length === 0,
    `${fromWorker.filter(([, w]) => w).length}/${fromWorker.length} code responses from the service worker, ` +
      `${codeRequests.length} code requests reached the server${codeRequests.length ? ` (${codeRequests.slice(0, 5).join(', ')})` : ''}, ` +
      `started in ${((Date.now() - started) / 1000).toFixed(1)} s`
  );

  // 3. Offline: the site's server is gone and the browser has no network.
  await stop();
  await page.setOfflineMode(true);
  const offline = await page.reload({ waitUntil: 'domcontentloaded' }).catch(error => error);
  await waitFor(() => document.documentElement.dataset.boot === 'startApp', 'the app to start offline', 60_000).catch(() => undefined);
  await waitFor(() => document.documentElement.dataset.webStatus?.startsWith('card:'), 'the connection status', 15_000).catch(() => undefined);
  const offlineState = await page.evaluate(() => ({
    url: location.href,
    boot: document.documentElement.dataset.boot,
    status: document.documentElement.dataset.webStatus ?? null,
    text: document.querySelector('.web-shell-status')?.textContent ?? null,
  }));
  check(
    'offline: the app loads from the cache and shows its connection state',
    !(offline instanceof Error) && offlineState.url === appUrl && offlineState.boot === 'startApp' && offlineState.status?.startsWith('card:'),
    JSON.stringify(offlineState)
  );
  await page.setOfflineMode(false);
  await start();

  // 4. Data-only redeployment (the daily Tor directory refresh).
  version = 'b';
  requests.length = 0;
  await load();
  const updated = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.update();
    await new Promise(resolve => setTimeout(resolve, 2000));
    return { installing: registration.installing != null, waiting: registration.waiting != null };
  });
  await new Promise(resolve => setTimeout(resolve, 1000));
  const afterData = await status();
  const banner = await page.$('[data-web-banner="update"]');
  check(
    'data-only change: no update offered',
    !updated.installing && !updated.waiting && afterData.status?.updateReady === false && !banner,
    `new worker: ${updated.installing || updated.waiting}, updateReady ${afterData.status?.updateReady}, banner ${Boolean(banner)}`
  );
  check('data-only change: the new Tor directory is fetched', requests.some(p => p.endsWith('/transport/tor/consensus.txt.br')));

  // 5. Code redeployment.
  version = 'c';
  started = Date.now();
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await waitFor(() => document.querySelector('[data-web-banner="update"]'), 'the update banner', 120_000);
  const bannerSeconds = (Date.now() - started) / 1000;
  const before = await shellCss();
  await load();
  await waitFor(() => document.querySelector('[data-web-banner="update"]'), 'the update banner after a reload', 30_000);
  const afterReload = await shellCss();
  check(
    'code change: update offered, the running version kept until accepted',
    !before.includes(MARKER) && !afterReload.includes(MARKER),
    `banner after ${bannerSeconds.toFixed(1)} s; old version served before and after a reload`
  );
  // A hard reload loads the newest deployment from the server, without the
  // worker; the page reloads once through it, all of it in the version in
  // use (taking it over as it is would mix the two versions).
  await page.reload({ ignoreCache: true, waitUntil: 'domcontentloaded' });
  await waitFor(() => window.__webBoot?.control != null && document.documentElement.dataset.boot === 'startApp', 'the app after a hard reload');
  await waitFor(() => document.querySelector('[data-web-banner="update"]'), 'the update banner after a hard reload', 30_000);
  const hard = await page.evaluate(() => ({ control: window.__webBoot.control, controlled: navigator.serviceWorker.controller != null }));
  const afterHardReload = await shellCss();
  check(
    'code change: after a hard reload, the version in use, through the worker',
    hard.control === 'reloaded' && hard.controlled && !afterHardReload.includes(MARKER),
    JSON.stringify(hard)
  );
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('[data-testid="update-reload"]')]);
  await waitFor(() => window.__webServiceWorker?.status != null, 'the service worker status');
  const accepted = await shellCss();
  const final = await status();
  check(
    'code change: accepted, the new version is served',
    accepted.includes(MARKER) && final.status?.updateReady === false && !(await page.$('[data-web-banner="update"]')),
    `serving build ${final.status?.approved.slice(0, 12)}`
  );

  problems.push(...(await watcher.report()));
  for (const e of pageErrors) problems.push(`uncaught exception: ${e}`);
  ok = problems.length === 0;
} catch (error) {
  problems.push(error.stack ?? error.message);
} finally {
  await browser.close().catch(() => undefined);
  await stop().catch(() => undefined);
  await rm(WORK, { recursive: true, force: true });
}
console.log('\nservice worker checks:');
for (const line of results) console.log(`  ${line}`);
for (const p of problems) console.log(`SW FAIL: ${p}`);
console.log(ok ? 'SW PASS' : 'SW FAIL');
process.exit(ok ? 0 : 1);
