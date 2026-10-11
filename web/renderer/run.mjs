// SPDX-License-Identifier: AGPL-3.0-only
//
// Boots the web app (web/dist/site/app/) in headless Chromium and reports
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

import jsQR from 'jsqr';

import { BASE_PATH, LOCAL_ORIGIN, launchBrowser, serveSite, watchPage } from '../scripts/harness.mjs';

const target = process.argv[2];
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 5000);
const server = target ? null : await serveSite();
const browser = await launchBrowser();

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
  // Let startApp run until Desktop shows the QR code (or gives up).
  await page
    .waitForFunction(
      selector =>
        document.documentElement.dataset.boot === 'failed' ||
        document.querySelector(selector) ||
        document.querySelector('.module-InstallScreenErrorStep'),
      { timeout: QR_TIMEOUT_MS },
      EXPECTED_STOP
    )
    .catch(() => undefined);
  const qrSeconds = (Date.now() - started) / 1000;
  const qr = await decodeQrCode(page);
  await new Promise(resolve => setTimeout(resolve, SETTLE_MS));

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
  if (qr.ok) console.log(`qr-seconds: ${qrSeconds.toFixed(1)}`);
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
  console.log('::error title=web app boot failed::the web app did not show the link QR code');
}
process.exit(ok ? 0 : 1);

/**
 * Draws the rendered QR code (an inline SVG) onto a canvas with a white quiet
 * zone, decodes it with jsQR and checks it is Desktop's link URL
 * (ts/util/signalRoutes.std.ts linkDeviceRoute, ts/textsecure/Provisioner).
 */
async function decodeQrCode(page) {
  const pixels = await page
    .evaluate(async selector => {
      const svg = document.querySelector(selector);
      if (!svg) return null;
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
      await img.decode();
      const size = 400;
      const margin = 40;
      const canvas = document.createElement('canvas');
      canvas.width = size + 2 * margin;
      canvas.height = size + 2 * margin;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = false;
      context.drawImage(img, margin, margin, size, size);
      const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
      let binary = '';
      for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return { data: btoa(binary), width, height };
    }, EXPECTED_STOP)
    .catch(error => ({ error: error.message }));
  if (!pixels) return { ok: false, reason: 'not rendered' };
  if (pixels.error) return { ok: false, reason: `could not read the image: ${pixels.error}` };
  const decoded = jsQR(new Uint8ClampedArray(Buffer.from(pixels.data, 'base64')), pixels.width, pixels.height);
  if (!decoded) return { ok: false, reason: 'jsQR could not decode it' };
  let url;
  try {
    url = new URL(decoded.data);
  } catch {
    return { ok: false, reason: 'not a URL' };
  }
  const uuid = url.searchParams.get('uuid');
  const pubKey = url.searchParams.get('pub_key');
  const capabilities = url.searchParams.get('capabilities');
  const key = pubKey ? Buffer.from(pubKey, 'base64') : Buffer.alloc(0);
  const problems = [];
  if (url.protocol !== 'sgnl:' || url.host !== 'linkdevice') problems.push(`unexpected URL ${url.protocol}//${url.host}`);
  // The provisioning address the server pushed: an opaque base64 token.
  if (!uuid || !/^[A-Za-z0-9+/_=-]{16,}$/.test(uuid)) {
    problems.push(`missing or malformed uuid (provisioning address): ${uuid ? `${uuid.length} chars, ${uuid.replace(/[A-Za-z0-9]/g, '')}` : 'absent'}`);
  }
  if (key.length !== 33 || key[0] !== 0x05) problems.push(`pub_key is not a 33-byte Curve25519 public key (${key.length} bytes)`);
  if (capabilities == null) problems.push('missing capabilities');
  if (problems.length) return { ok: false, reason: problems.join('; ') };
  return {
    ok: true,
    summary: `sgnl://linkdevice?uuid=<${uuid.length} chars>&pub_key=<33-byte key>&capabilities=${capabilities}`,
  };
}
