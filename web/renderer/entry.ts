// SPDX-License-Identifier: AGPL-3.0-only
//
// Entry point of the web app (index.html loads this, no inline scripts).
//
// Order matters, as in Electron:
//   0. Tor starts bootstrapping (web/net/carrier.ts), in the background;
//   1. libsignal's WebAssembly is instantiated (it must be ready before any
//      module that imports @signalapp/libsignal-client is evaluated);
//   2. the in-page main process starts: config, locale, IPC handlers;
//   3. Desktop's preload graph runs (ts/windows/main/preload.preload.ts:
//      context, phase1-ipc, phase2-dependencies, phase3-post-signal), all
//      imported dynamically so steps 1-2 come first;
//   4. window.startApp(), as background.html's last script does.
//
// Progress is recorded in <html data-boot="..."> and window.__webBoot (read
// by the browser tests); a failure stops the boot with a visible error.

import { initLibsignal } from '@signalapp/libsignal-client/wasm/index.js';
import { config as configureZod } from 'zod';

import { startCarrier } from '../net/carrier.ts';

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

async function boot(): Promise<void> {
  step('start');

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
  try {
    main = await import('../main/index.ts');
    await main.startMain();
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
  main.onRendererLoaded();

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
