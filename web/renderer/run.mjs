// SPDX-License-Identifier: AGPL-3.0-only
//
// Boots the web app (web/dist/site/app/) in headless Chromium and reports
// how far Desktop's startup gets.
//
//   node renderer/run.mjs                       serve web/dist/site under /receiver/
//   node renderer/run.mjs https://insertokname.github.io/receiver/
//
// Expected until the network layer exists: libsignal loads, the in-page main
// process starts, the SQL worker creates the encrypted database and runs
// all of Desktop's migrations, Desktop's preload phases and startApp() run,
// and Desktop mounts its React root on the install (link device) screen.
// The QR code needs the provisioning connection, so the screen shows its
// loading or error state. Fails on anything else, on uncaught exceptions,
// on CSP violations, on direct network destinations other than the page's
// origin (and the Tor entry points), and on key-like secrets in the log.

import { BASE_PATH, LOCAL_ORIGIN, launchBrowser, serveSite, watchPage } from '../scripts/harness.mjs';

const target = process.argv[2];
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 5000);
const server = target ? null : await serveSite();
const browser = await launchBrowser();

// Where the boot stops today: Desktop's install screen (React).
const EXPECTED_STOP = '[class^="module-InstallScreen"], [class*=" module-InstallScreen"]';
// 32-byte keys in hex (the database key), Desktop's PRAGMA key.
const SECRET_PATTERNS = [/\b[0-9a-f]{64}\b/i, /PRAGMA key/i];

let ok = false;
try {
  const page = await browser.newPage();
  const watcher = await watchPage(page);
  const pageErrors = [];
  const logLines = [];
  const quiet = /\[updateSchema\(\d+\)\] success$/;
  page.on('console', m => {
    const text = m.text();
    logLines.push(text);
    if (!quiet.test(text)) console.log(`  | ${text.slice(0, 400)}`);
  });
  page.on('pageerror', e => {
    pageErrors.push({ message: e.message });
    console.log(`  PAGEERROR ${e.message}`);
  });
  page.on('response', r => {
    if (r.status() >= 400) console.log(`  HTTP ${r.status()} ${r.url()}`);
  });
  page.on('requestfailed', r => {
    if (!r.url().startsWith('data:')) console.log(`  REQUESTFAILED ${r.url()} ${r.failure()?.errorText}`);
  });

  const url = new URL('app/', target ?? `${LOCAL_ORIGIN}${BASE_PATH}`).href;
  console.log(`web app: ${url}`);
  const started = Date.now();
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new Error(`page load failed: HTTP ${response?.status()}`);

  await page.waitForFunction(
    () => ['startApp', 'failed'].includes(document.documentElement.dataset.boot),
    { timeout: 120_000 }
  );
  // Let startApp run until Desktop shows the install screen.
  await page
    .waitForFunction(
      selector => document.documentElement.dataset.boot === 'failed' || document.querySelector(selector),
      { timeout: 90_000 },
      EXPECTED_STOP
    )
    .catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, SETTLE_MS));

  const state = await page.evaluate(selector => {
    const loading = document.querySelector('.app-loading-screen');
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    const install = document.querySelector(selector);
    return {
      boot: window.__webBoot,
      bootState: document.documentElement.dataset.boot,
      appLoaded: Boolean(document.documentElement.dataset.appLoaded),
      title: document.title,
      lang: document.documentElement.lang,
      loadingScreenVisible: loading ? getComputedStyle(loading).display !== 'none' : false,
      fontsLoaded: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family),
      errorDialog: dialog ? dialog.textContent.trim().slice(0, 300) : null,
      installScreen: install
        ? {
            className: install.className,
            text: install.textContent.trim().replace(/\s+/g, ' ').slice(0, 300),
            qrCode: [...install.querySelectorAll('[class*="qr-code"]')].map(e => e.className).slice(0, 4),
          }
        : null,
      storage: window.__webStorage ?? null,
    };
  }, EXPECTED_STOP);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log('');
  console.log(`boot steps: ${state.boot.steps.map(s => `${s.step}@${s.ms}ms`).join(' -> ')}`);
  console.log(`boot error: ${state.boot.error ?? '(none)'}`);
  console.log(`state: ${state.bootState}, app loaded: ${state.appLoaded}, title "${state.title}", lang ${state.lang}, ${elapsed} s`);
  console.log(`loading screen visible: ${state.loadingScreenVisible}`);
  console.log(`fonts loaded: ${[...new Set(state.fontsLoaded)].join(', ') || '(none)'}`);
  console.log(`error dialog (React): ${state.errorDialog ?? '(none)'}`);
  console.log(`storage: ${JSON.stringify(state.storage)}`);
  console.log(`install screen: ${state.installScreen ? JSON.stringify(state.installScreen) : '(none)'}`);
  const ipcStubs = logLines.filter(l => l.startsWith('web main:'));
  console.log(`web main notes (${ipcStubs.length}):`);
  for (const line of ipcStubs) console.log(`  ${line}`);
  const unhandled = logLines.filter(l => /Top-level unhandled/.test(l));
  console.log(`Desktop-logged unhandled errors: ${unhandled.length}`);
  for (const line of unhandled) console.log(`  ${line.slice(0, 300)}`);
  console.log(`uncaught exceptions: ${pageErrors.length}`);
  const secrets = logLines.filter(l => SECRET_PATTERNS.some(p => p.test(l)));
  console.log(`log lines that look like secrets: ${secrets.length} (of ${logLines.length})`);

  const problems = await watcher.report();
  const stepNames = state.boot.steps.map(s => s.step);
  for (const s of ['libsignal', 'main', 'preload', 'startApp']) {
    if (!stepNames.includes(s)) problems.push(`boot step "${s}" not reached`);
  }
  if (state.boot.error) problems.push(`boot failed: ${state.boot.error}`);
  if (!state.storage?.info) problems.push(`database not open: ${state.storage?.error ?? 'no storage status'}`);
  if (!state.installScreen) problems.push('the install screen (React) was not rendered');
  if (state.loadingScreenVisible) problems.push('the loading screen is still visible');
  for (const e of pageErrors) problems.push(`uncaught exception: ${e.message}`);
  for (const line of unhandled) problems.push(`unhandled error: ${line.slice(0, 200)}`);
  for (const line of secrets) problems.push(`secret-looking log line: ${line.slice(0, 80)}...`);
  for (const p of problems) console.log(`WEBAPP FAIL: ${p}`);
  ok = problems.length === 0;
  console.log(ok ? 'WEBAPP PASS' : 'WEBAPP FAIL');
} catch (e) {
  console.log(`WEBAPP FAIL: ${e.stack ?? e.message}`);
} finally {
  await browser.close();
  server?.close();
}
if (!ok && process.env.GITHUB_ACTIONS) {
  console.log('::error title=web app boot failed::the web app did not boot to the install screen');
}
process.exit(ok ? 0 : 1);
