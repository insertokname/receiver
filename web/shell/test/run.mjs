// SPDX-License-Identifier: AGPL-3.0-only
//
// The app shell's recovery paths (web/shell), on the built site in headless
// Chromium (no Signal account involved; the app stays on its link screen):
//
//   (a) the database key is missing: "receiver can't open its data" ->
//       "Delete data and link again" -> confirmed -> the app starts afresh;
//   (b) the browser wiped the data of a linked app (database and key gone,
//       the 'linked' mark left): "Your messages on this device were
//       removed" -> "Link again" -> the link screen;
//   (c) a second window while the first is hung (no answer): the lock
//       wait, then "open in another window"; once the first runs again,
//       "Use here" takes over;
//   (d) persistent storage is never asked for before linking;
//   (e) on a Mac (navigator.platform), Desktop picks its macOS shortcuts.
//
// Fails on CSP violations, uncaught exceptions and network destinations
// other than the page's origin and the Tor entry points.
//
//   node shell/test/run.mjs     (needs web/dist/site and $CHROMIUM)

import { BASE_PATH, LOCAL_ORIGIN, launchBrowser, serveSite, watchPage } from '../../scripts/harness.mjs';

const appUrl = `${LOCAL_ORIGIN}${BASE_PATH}`;
// Same origin, no database: the transport checks page (not started).
const otherPageUrl = `${appUrl}test/`;

const server = await serveSite();
const browser = await launchBrowser();
const problems = [];
const results = [];
const pageErrors = [];
const watchers = [];
let ok = false;

function check(name, condition, detail) {
  results.push(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!condition) problems.push(`${name}${detail ? `: ${detail}` : ''}`);
}

async function newPage(context) {
  const page = await context.newPage();
  watchers.push(await watchPage(page));
  page.on('pageerror', e => {
    pageErrors.push(e.message);
    console.log(`  PAGEERROR ${e.stack ?? e.message}`);
  });
  page.on('console', m => {
    if (/web shell|web boot|database/i.test(m.text())) console.log(`  | ${m.text().slice(0, 200)}`);
  });
  return page;
}

const waitFor = (page, fn, what, timeout = 60_000, ...args) =>
  page.waitForFunction(fn, { timeout, polling: 200 }, ...args).catch(() => {
    throw new Error(`timed out waiting for ${what}`);
  });

const appStarted = page => waitFor(page, () => window.__webStorage?.info != null, 'the database to open');
const screen = (page, id) => waitFor(page, i => document.querySelector(`[data-web-screen="${i}"]`), `the "${id}" screen`, 60_000, id);

async function eraseOutsideApp(page, { key, files }) {
  await page.goto(otherPageUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    async ({ key, files }) => {
      if (key) {
        await new Promise((resolve, reject) => {
          const req = indexedDB.deleteDatabase('receiver-sql-key');
          req.onsuccess = resolve;
          req.onerror = () => reject(req.error);
        });
      }
      if (files) {
        // The app's SQL worker may still be shutting down: retry.
        const root = await navigator.storage.getDirectory();
        for (let attempt = 0; ; attempt++) {
          try {
            await root.removeEntry('userData', { recursive: true });
            break;
          } catch (error) {
            if (attempt >= 20) throw error;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        }
      }
    },
    { key, files }
  );
}

try {
  const context = await browser.createBrowserContext();
  const page = await newPage(context);

  // (d) and setup: a first start.
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await appStarted(page);
  await new Promise(resolve => setTimeout(resolve, 1500));
  const persist = await page.evaluate(() => window.__webPersist ?? null);
  check('(d) persistent storage not asked for before linking', persist === null, JSON.stringify(persist));

  // (a) The key is missing.
  await eraseOutsideApp(page, { key: true, files: false });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await screen(page, 'database-unreadable');
  const errorName = await page.evaluate(() => document.documentElement.dataset.webDatabaseError);
  await page.click('[data-testid="delete-data"]');
  await screen(page, 'confirm-delete');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('[data-testid="confirm-delete-data"]')]);
  await appStarted(page);
  const afterDelete = await page.evaluate(() => ({ created: window.__webStorage.info.created, screen: document.documentElement.dataset.webScreen ?? null }));
  check(
    '(a) missing key: "Delete data and link again" starts the app afresh',
    errorName === 'DatabaseKeyError' && afterDelete.created === true && afterDelete.screen === null,
    `${errorName}; then ${JSON.stringify(afterDelete)}`
  );

  // (b) A linked app's data is wiped by the browser.
  await page.evaluate(() => localStorage.setItem('receiver:linked', 'true'));
  await eraseOutsideApp(page, { key: true, files: true });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await screen(page, 'data-wiped');
  await page.click('[data-testid="link-again"]');
  await waitFor(page, () => !document.querySelector('[data-web-screen]'), 'the screen to close');
  const wiped = await page.evaluate(() => ({ created: window.__webStorage?.info?.created, linked: localStorage.getItem('receiver:linked') }));
  check('(b) wiped data: explained, then the link screen', wiped.created === true && wiped.linked === 'false', JSON.stringify(wiped));

  // (c) A second window while the first one is hung.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await appStarted(page);
  const cdp = await page.createCDPSession();
  // A hung window: its main thread stops (its SQL worker keeps the lock).
  await cdp.send('Debugger.enable');
  await cdp.send('Debugger.pause');
  const second = await newPage(context);
  const opened = Date.now();
  await second.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await screen(second, 'open-elsewhere');
  const inUseSeconds = (Date.now() - opened) / 1000;
  const inUseError = await second.evaluate(() => document.documentElement.dataset.webDatabaseError ?? null);
  console.log(`second window: screen after ${inUseSeconds.toFixed(1)} s, database error: ${inUseError}`);
  await cdp.send('Debugger.resume');
  const clicked = Date.now();
  await Promise.all([second.waitForNavigation({ waitUntil: 'domcontentloaded' }), second.click('[data-testid="use-here"]')]);
  await appStarted(second);
  const takeOverSeconds = (Date.now() - clicked) / 1000;
  await screen(page, 'open-elsewhere');
  check(
    '(c) hung first window: lock wait, then "Use here" takes over once it runs again',
    inUseError === 'DatabaseInUseError',
    `"open in another window" after ${inUseSeconds.toFixed(1)} s (${inUseError}); database open ${takeOverSeconds.toFixed(1)} s after "Use here"; the first window shows the screen`
  );

  // (e) A Mac.
  const macContext = await browser.createBrowserContext();
  const mac = await newPage(macContext);
  await mac.evaluateOnNewDocument(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
  });
  await mac.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await waitFor(mac, () => window.reduxStore?.getState().user?.platform != null, 'the app state');
  const platforms = await mac.evaluate(() => ({ window: window.platform, redux: window.reduxStore.getState().user.platform }));
  check('(e) Mac: Cmd shortcuts', platforms.window === 'darwin' && platforms.redux === 'darwin', JSON.stringify(platforms));

  for (const watcher of watchers) problems.push(...(await watcher.report()));
  for (const e of pageErrors) problems.push(`uncaught exception: ${e}`);
  ok = problems.length === 0;
} catch (error) {
  problems.push(error.stack ?? error.message);
} finally {
  await browser.close().catch(() => undefined);
  server.close();
}
console.log('\napp shell checks:');
for (const line of results) console.log(`  ${line}`);
for (const p of problems) console.log(`SHELL FAIL: ${p}`);
console.log(ok ? 'SHELL PASS' : 'SHELL FAIL');
process.exit(ok ? 0 : 1);
