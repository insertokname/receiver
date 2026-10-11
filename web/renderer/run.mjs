// SPDX-License-Identifier: AGPL-3.0-only
//
// Boots the web app (web/dist/site/app/) in headless Chromium and reports
// how far Desktop's startup gets.
//
//   node renderer/run.mjs                       serve web/dist/site under /receiver/
//   node renderer/run.mjs https://insertokname.github.io/receiver/
//
// Expected until the storage layer exists: libsignal loads, the in-page main
// process starts, Desktop's preload phases run, window.startApp() runs and
// stops at its first database call with a clear error, shown in Desktop's
// own error dialog (React). Fails on anything else, on uncaught exceptions
// before that point, on CSP violations and on direct network destinations
// other than the page's origin (and the Tor entry points).

import { BASE_PATH, LOCAL_ORIGIN, launchBrowser, serveSite, watchPage } from '../scripts/harness.mjs';

const target = process.argv[2];
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 5000);
const server = target ? null : await serveSite();
const browser = await launchBrowser();

const EXPECTED_STOP = /SQL \(sql-channel:read\) is not available in the web build yet/;

let ok = false;
try {
  const page = await browser.newPage();
  const watcher = await watchPage(page);
  const pageErrors = [];
  const logLines = [];
  let sawExpectedStop = false;
  page.on('console', m => {
    const text = m.text();
    logLines.push(text);
    console.log(`  | ${text.slice(0, 400)}`);
    if (EXPECTED_STOP.test(text)) sawExpectedStop = true;
  });
  page.on('pageerror', e => {
    pageErrors.push({ message: e.message, afterStop: sawExpectedStop });
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
  // Let startApp run until it stops (or the app loads).
  await page
    .waitForFunction(() => document.documentElement.dataset.boot === 'failed' || document.documentElement.dataset.appLoaded, {
      timeout: 60_000,
    })
    .catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, SETTLE_MS));

  const state = await page.evaluate(() => {
    const loading = document.querySelector('.app-loading-screen');
    const logo = document.querySelector('.module-splash-screen__logo');
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    return {
      boot: window.__webBoot,
      bootState: document.documentElement.dataset.boot,
      appLoaded: Boolean(document.documentElement.dataset.appLoaded),
      title: document.title,
      lang: document.documentElement.lang,
      loadingScreenVisible: loading ? getComputedStyle(loading).display !== 'none' : false,
      logoBackground: logo ? getComputedStyle(logo).maskImage || getComputedStyle(logo).webkitMaskImage || getComputedStyle(logo).backgroundImage : null,
      fontsLoaded: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family),
      errorDialog: dialog ? dialog.textContent.trim().slice(0, 300) : null,
      stylesheets: document.styleSheets.length,
    };
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log('');
  console.log(`boot steps: ${state.boot.steps.map(s => `${s.step}@${s.ms}ms`).join(' -> ')}`);
  console.log(`boot error: ${state.boot.error ?? '(none)'}`);
  console.log(`state: ${state.bootState}, app loaded: ${state.appLoaded}, title "${state.title}", lang ${state.lang}, ${elapsed} s`);
  console.log(`loading screen visible: ${state.loadingScreenVisible}, logo: ${state.logoBackground?.slice(0, 80)}`);
  console.log(`fonts loaded: ${[...new Set(state.fontsLoaded)].join(', ') || '(none)'}`);
  console.log(`error dialog (React): ${state.errorDialog ?? '(none)'}`);
  const ipcStubs = logLines.filter(l => l.startsWith('web main:'));
  console.log(`web main notes (${ipcStubs.length}):`);
  for (const line of ipcStubs) console.log(`  ${line}`);
  const unhandled = logLines.filter(l => /Top-level unhandled/.test(l));
  console.log(`Desktop-logged unhandled errors: ${unhandled.length}`);
  for (const line of unhandled) console.log(`  ${line.slice(0, 300)}`);
  const before = pageErrors.filter(e => !e.afterStop);
  console.log(`uncaught exceptions: ${pageErrors.length} (${before.length} before the database stop)`);

  const problems = await watcher.report();
  const stepNames = state.boot.steps.map(s => s.step);
  for (const s of ['libsignal', 'main', 'preload', 'startApp']) {
    if (!stepNames.includes(s)) problems.push(`boot step "${s}" not reached`);
  }
  if (!state.appLoaded && !EXPECTED_STOP.test(state.boot.error ?? '')) {
    problems.push(`boot did not stop at the database: ${state.boot.error ?? state.bootState}`);
  }
  if (!state.appLoaded && !state.errorDialog) problems.push('the error dialog (React) was not rendered');
  if (!state.loadingScreenVisible && !state.appLoaded) problems.push('loading screen not visible');
  for (const e of before) problems.push(`uncaught exception before the database stop: ${e.message}`);
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
  console.log('::error title=web app boot failed::the web app did not boot to the expected point');
}
process.exit(ok ? 0 : 1);
