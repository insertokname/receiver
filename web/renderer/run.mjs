// SPDX-License-Identifier: AGPL-3.0-only
//
// Boots the web app (web/dist/site/, the site's root) in headless Chromium and reports
// how far Desktop's startup gets.
//
//   node renderer/run.mjs                       serve web/dist/site under /receiver/
//   node renderer/run.mjs https://insertokname.github.io/receiver/
//
// Expected: libsignal loads, Tor bootstraps in the background, the in-page
// main process starts, the SQL worker creates the encrypted database and
// runs all of Desktop's migrations, Desktop's preload phases and startApp()
// run, Desktop mounts its install (link device) screen, opens the
// provisioning connection to Signal through Tor and renders the link QR
// code. The QR code is decoded and must be Desktop's
// sgnl://linkdevice?uuid=...&pub_key=...&capabilities=... URL. Fails on
// anything else, on uncaught exceptions, on CSP violations, on direct
// network destinations other than the page's origin (and the Tor entry
// points), and on key-like secrets in the log.
//
// Prints `qr-seconds: <n>` (page load to QR code) for the timing reports.
// While waiting, the link screen must never show an error (Desktop's QR
// code attempts time out after 10 s; the app waits for Tor first and shows
// "Connecting...", see web/shell/status.ts): the states seen are printed.
// SCREENSHOT=<file.png> saves the final screen.
// LIVENESS=1: the bridge is reached through a local proxy; once the QR code
// is shown, the proxy black-holes the bridge connection (it stops delivering,
// without closing). The app must notice (webtor's keepalive), replace its Tor
// client and show a new QR code (a new provisioning connection, whose address
// Signal pushes) within LIVENESS_BOUND_SECS (default 60).

import { BASE_PATH, LOCAL_ORIGIN, decodeLinkQrCode, launchBrowser, serveSite, watchPage } from '../scripts/harness.mjs';
import { startTunnelProxy } from '../scripts/tunnel-proxy.mjs';

const target = process.argv[2];
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 5000);
const server = target ? null : await serveSite();
// BLACKHOLE=host1,host2 makes those hosts unreachable (e.g. the Snowflake
// WebSocket bridge, forcing the slower WebRTC fallback).
const blackholeHosts = (process.env.BLACKHOLE ?? '').split(',').filter(Boolean);
const proxy = process.env.LIVENESS ? await startTunnelProxy() : undefined;
const LIVENESS_BOUND_SECS = Number(process.env.LIVENESS_BOUND_SECS ?? 60);
const browser = await launchBrowser({ blackholeHosts, proxyPort: proxy?.port });

// Desktop's install screen (React), and on it the rendered link QR code.
const INSTALL_SCREEN = '[class^="module-InstallScreen"], [class*=" module-InstallScreen"]';
const EXPECTED_STOP = '.module-InstallScreenQrCodeNotScannedStep__qr-code--loaded svg';
const QR_TIMEOUT_MS = Number(process.env.QR_TIMEOUT_MS ?? 180_000);
// 32-byte keys in hex (the database key), Desktop's PRAGMA key.
const SECRET_PATTERNS = [/\b[0-9a-f]{64}\b/i, /PRAGMA key/i];

let ok = false;
try {
  const page = await browser.newPage();
  const watcher = await watchPage(page);
  const pageErrors = [];
  const logLines = [];
  let bridgeLostAt;
  const quiet = /\[updateSchema\(\d+\)\] success$/;
  page.on('console', m => {
    const text = m.text();
    logLines.push(text);
    if (!bridgeLostAt && /replacing the Tor client \(lost the bridge/.test(text)) bridgeLostAt = Date.now();
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

  const url = new URL(target ?? `${LOCAL_ORIGIN}${BASE_PATH}`).href;
  console.log(`web app: ${url}`);
  const started = Date.now();
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new Error(`page load failed: HTTP ${response?.status()}`);

  await page.waitForFunction(
    () => ['startApp', 'failed'].includes(document.documentElement.dataset.boot),
    { timeout: 120_000 }
  );
  // Sample what the link screen shows while Tor connects.
  const seen = { status: new Set(), errors: new Set() };
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      // eslint-disable-next-line no-await-in-loop
      const sample = await page
        .evaluate(() => ({
          status: document.documentElement.dataset.webStatus ?? null,
          // Visible: the shell covers an error it is retrying with "Connecting...".
          error: document.querySelector('.web-shell-status--card')
            ? null
            : (document.querySelector('.module-InstallScreenErrorStep, [class*="qr-code__error-message"]')?.textContent?.trim() ??
              null),
          retrying: Boolean(document.querySelector('.web-shell-status--card')) &&
            Boolean(document.querySelector('.module-InstallScreenErrorStep, [class*="qr-code__error-message"]')),
        }))
        .catch(() => null);
      if (sample?.status) seen.status.add(sample.status);
      if (sample?.error) seen.errors.add(sample.error.slice(0, 120));
      if (sample?.retrying) seen.status.add('retrying the link screen');
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  })();
  // Let startApp run until Desktop shows the QR code (or an error the shell
  // does not retry).
  await page
    .waitForFunction(
      selector =>
        document.documentElement.dataset.boot === 'failed' ||
        document.querySelector(selector) ||
        (document.querySelector('.module-InstallScreenErrorStep') && !document.querySelector('.web-shell-status--card')),
      { timeout: QR_TIMEOUT_MS },
      EXPECTED_STOP
    )
    .catch(() => undefined);
  const qrSeconds = (Date.now() - started) / 1000;
  sampling = false;
  await sampler;
  const qr = await decodeLinkQrCode(page, EXPECTED_STOP);
  await new Promise(resolve => setTimeout(resolve, SETTLE_MS));

  let liveness;
  if (proxy && qr.ok) {
    proxy.blackholeAll();
    const blackholed = Date.now();
    console.log(`liveness: ${proxy.stats.blackholed} bridge connection(s) black-holed`);
    let next;
    while (Date.now() - blackholed < LIVENESS_BOUND_SECS * 1000) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 500));
      // eslint-disable-next-line no-await-in-loop
      next = await decodeLinkQrCode(page, EXPECTED_STOP).catch(() => undefined);
      if (next?.ok && next.url !== qr.url) break;
    }
    const seconds = (Date.now() - blackholed) / 1000;
    liveness = {
      noticed: bridgeLostAt ? (bridgeLostAt - blackholed) / 1000 : undefined,
      newQr: next?.ok && next.url !== qr.url ? seconds : undefined,
    };
  }

  const state = await page.evaluate(selector => {
    const loading = document.querySelector('.app-loading-screen');
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    const install = document.querySelector(selector);
    const tor = document.documentElement.dataset.tor ?? null;
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
      tor,
    };
  }, INSTALL_SCREEN);
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
  console.log(`tor: ${state.tor}`);
  console.log(`qr code: ${qr.ok ? qr.summary : `(none: ${qr.reason})`}`);
  console.log(`connection status shown while waiting: ${[...seen.status].join(', ') || '(none)'}`);
  console.log(`link screen errors seen: ${seen.errors.size}${seen.errors.size ? ` (${[...seen.errors].join(' | ')})` : ''}`);
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  if (qr.ok) console.log(`qr-seconds: ${qrSeconds.toFixed(1)}`);
  if (liveness) {
    console.log(
      `liveness: bridge loss noticed after ${liveness.noticed?.toFixed(1) ?? '(never)'} s, new QR code after ${liveness.newQr?.toFixed(1) ?? '(none)'} s (bound ${LIVENESS_BOUND_SECS} s)`
    );
  }
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
  if (!qr.ok) problems.push(`no valid link QR code: ${qr.reason}`);
  if (proxy && qr.ok && liveness?.newQr === undefined) {
    problems.push(`no new QR code within ${LIVENESS_BOUND_SECS} s of the black hole`);
  }
  if (proxy && qr.ok && liveness?.noticed === undefined) problems.push('the lost bridge was not noticed');
  for (const error of seen.errors) problems.push(`the link screen showed an error: ${error}`);
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
  await proxy?.close();
}
if (!ok && process.env.GITHUB_ACTIONS) {
  console.log('::error title=web app boot failed::the web app did not show the link QR code');
}
process.exit(ok ? 0 : 1);
