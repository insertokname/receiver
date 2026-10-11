// SPDX-License-Identifier: AGPL-3.0-only
//
// Entry point of the web app (index.html loads this, no inline scripts).
//
// Order matters, as in Electron:
//   0. the app shell (web/shell) makes sure no other window uses the app
//      ("Use here"); then Tor starts bootstrapping (web/net/carrier.ts), in
//      the background;
//   1. libsignal's WebAssembly is instantiated (it must be ready before any
//      module that imports @signalapp/libsignal-client is evaluated);
//   2. the in-page main process starts: config, locale, IPC handlers;
//   3. Desktop's preload graph runs (ts/windows/main/preload.preload.ts:
//      context, phase1-ipc, phase2-dependencies, phase3-post-signal), all
//      imported dynamically so steps 1-2 come first;
//   4. once the database is open, window.startApp(), as background.html's
//      last script does; if it could not be opened, the shell's screens
//      take the place of Electron's database error dialogs.
//
// Progress is recorded in <html data-boot="..."> and window.__webBoot (read
// by the browser tests); a failure stops the boot with a visible error.

import { initLibsignal } from '@signalapp/libsignal-client/wasm/index.js';
import { config as configureZod } from 'zod';

import { startCarrier } from '../net/carrier.ts';
import { installDebugLogLink } from '../shell/debug-log.ts';
import { showDatabaseError, showQuotaError, showRuntimeDatabaseError } from '../shell/errors.ts';
import { installNotificationBanner } from '../shell/notifications.ts';
import { installConnectionStatus } from '../shell/status.ts';
import { checkForWipedData, installStorageGuards } from '../shell/storage.ts';
import { claimTab, onRelease } from '../shell/tabs.ts';
import { installServiceWorker } from '../shell/update.ts';

// zod probes `new Function` (a CSP violation under script-src 'self') unless
// told not to compile validators.
configureZod({ jitless: true });

type BootStep = { step: string; ms: number };

declare global {
  interface Window {
    __webBoot: { steps: Array<BootStep>; error?: string };
  }
}

const bootStarted = performance.now();
window.__webBoot = { steps: [] };

function step(name: string): void {
  window.__webBoot.steps.push({ step: name, ms: Math.round(performance.now() - bootStarted) });
  document.documentElement.dataset.boot = name;
  // oxlint-disable-next-line no-console
  console.log(`web boot: ${name}`);
}

function fail(name: string, error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  window.__webBoot.error = `${name}: ${message}`;
  document.documentElement.dataset.boot = 'failed';
  // oxlint-disable-next-line no-console
  console.error(`web boot: ${name} failed: ${error instanceof Error ? error.stack : message}`);
  const placeholder = document.querySelector('.app-loading-screen .message-placeholder');
  if (placeholder) {
    placeholder.textContent = `Could not start (${name}): ${message}`;
  }
  if ('SignalContext' in window) {
    import('./boot-error.tsx')
      .then(({ showBootError }) => {
        showBootError(`${name}: ${message}`);
        document.documentElement.dataset.bootErrorShown = 'true';
      })
      .catch(renderError => {
        // oxlint-disable-next-line no-console
        console.error('web boot: could not show the error dialog', renderError);
      });
  }
}

// Keyboard shortcuts: the web build runs Desktop's Linux code paths
// (process.platform), but on a Mac Desktop's shortcuts and their labels
// should use Cmd. Only window.platform, which picks shortcuts and their
// labels, says 'darwin' there.
function isMac(): boolean {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform;
  return /^mac/i.test(platform);
}

async function boot(): Promise<void> {
  step('start');

  // The app shell: its service worker (updates only with the user's
  // consent), connection status and banners. They show only when relevant.
  window.addEventListener('load', () => setTimeout(installServiceWorker, 1000), { once: true });
  installConnectionStatus();
  installNotificationBanner();
  installDebugLogLink();
  installStorageGuards();

  // One window at a time: nothing starts while another window uses the app.
  await claimTab();
  step('tab');

  // Tor bootstraps while the app starts, so that Signal is reachable by the
  // time Desktop asks for the link QR code (WhatsApp Web shows its code as
  // soon as it can, too).
  startCarrier();

  try {
    await initLibsignal();
  } catch (error) {
    fail('libsignal', error);
    return;
  }
  step('libsignal');

  let main: typeof import('../main/index.ts');
  let sql: typeof import('../main/sql.ts');
  let database: Awaited<ReturnType<typeof main.startMain>>['database'];
  try {
    main = await import('../main/index.ts');
    sql = await import('../main/sql.ts');
    ({ database } = await main.startMain());
    // A file (attachment, avatar, draft) could not be written: storage full.
    main.onStorageFull(showQuotaError);
    onRelease(sql.closeDatabase);
  } catch (error) {
    fail('main', error);
    return;
  }
  step('main');

  try {
    await import('../../ts/windows/main/preload.preload.ts');
  } catch (error) {
    fail('preload', error);
    return;
  }
  step('preload');
  try {
    await main.onRendererLoaded();
  } catch (error) {
    fail('main', error);
    return;
  }

  // Electron's main process waits for the database before the app starts
  // and shows a dialog instead if it failed.
  const result = await database;
  const recovery = { deleteAllData: sql.deleteAllData };
  if (!result.ok) {
    document.documentElement.dataset.boot = 'database-error';
    // oxlint-disable-next-line no-console
    console.error(`web boot: the database did not open: ${result.error.name}`);
    showDatabaseError(result.error, recovery);
    return;
  }
  checkForWipedData(result.info.created);
  sql.onDatabaseFailure(error => showRuntimeDatabaseError(error, recovery));
  if (isMac()) {
    window.platform = 'darwin';
  }

  // From background.html.
  document
    .querySelector('.app-loading-screen')
    ?.addEventListener('dblclick', () => window.IPC?.showDebugLog());

  // startApp() resolves only when the app has fully started; boot progress
  // after this point is Desktop's own (logged by its logger).
  step('startApp');
  Promise.resolve(window.startApp() as unknown).catch((error: unknown) =>
    fail('startApp', error)
  );
}

void boot();
