// SPDX-License-Identifier: AGPL-3.0-only
//
// The service worker (web/sw/sw.ts) and new versions of the app, like
// WhatsApp Web: a new deployment is downloaded in the background, then
// "A new version of receiver is available" offers to reload. Until the
// user accepts, every load (this window's lazily loaded code, reloads,
// new windows) keeps getting the version in use.

import { h } from './ui.ts';

type Status = { build: string; approved: string; updateReady: boolean };

// How often an open window looks for a new version (the browser also
// checks on every load).
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

declare global {
  interface Window {
    // Read by the browser tests (web/sw/test).
    __webServiceWorker?: { registered: boolean; error?: string; status?: Status };
  }
}

function ask(worker: ServiceWorker, type: 'status' | 'apply' | 'remember', paths?: Array<string>): Promise<Status> {
  return new Promise((resolve, reject) => {
    const { port1, port2 } = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('the service worker did not answer')), 30_000);
    port1.onmessage = event => {
      clearTimeout(timer);
      const reply = event.data as { ok: boolean; value?: Status; error?: string };
      if (reply.ok && reply.value) {
        resolve(reply.value);
      } else {
        reject(new Error(reply.error ?? 'service worker error'));
      }
    };
    worker.postMessage({ type, paths }, [port2]);
  });
}

let banner: HTMLElement | undefined;

function showUpdateBanner(onReload: () => void): void {
  if (banner) {
    return;
  }
  const button = h(
    'button',
    { type: 'button', class: 'web-shell-banner__link', 'data-testid': 'update-reload' },
    'Click to reload'
  );
  button.addEventListener('click', onReload);
  banner = h(
    'div',
    { class: 'web-shell web-shell-banner web-shell-banner--top', role: 'status', 'data-web-banner': 'update' },
    h('div', { class: 'web-shell-banner__text' }, h('strong', {}, 'A new version of receiver is available'), button)
  );
  document.body.append(banner);
}

export function installServiceWorker(): void {
  const state: NonNullable<Window['__webServiceWorker']> = { registered: false };
  window.__webServiceWorker = state;
  if (!('serviceWorker' in navigator)) {
    state.error = 'service workers are not available';
    return;
  }
  const { serviceWorker } = navigator;
  let remembered = false;

  const check = async () => {
    const worker = serviceWorker.controller ?? (await serviceWorker.ready).active;
    if (!worker) {
      return;
    }
    if (!remembered) {
      // What this page loaded before the worker was there (first visit).
      remembered = true;
      const base = new URL('./', document.baseURI);
      const paths = performance
        .getEntriesByType('resource')
        .map(entry => new URL(entry.name))
        .filter(url => url.origin === base.origin && url.pathname.startsWith(base.pathname))
        .map(url => decodeURIComponent(url.pathname.slice(base.pathname.length)));
      await ask(worker, 'remember', [...new Set(paths)]);
    }
    const status = await ask(worker, 'status');
    if (state.status?.approved !== status.approved) {
      // oxlint-disable-next-line no-console
      // Shortened: the full id (in sw.js) looks like a key to log scanners.
      console.log(`web shell: app build ${status.approved.slice(0, 16)} (sw.js lists its files and their SHA-256)`);
    }
    state.status = status;
    if (status.updateReady) {
      showUpdateBanner(() => {
        void ask(worker, 'apply').then(
          () => window.location.reload(),
          error => {
            // oxlint-disable-next-line no-console
            console.error('web shell: switching to the new version failed', error);
            window.location.reload();
          }
        );
      });
    }
  };
  const checkLogged = () =>
    check().catch(error => {
      // oxlint-disable-next-line no-console
      console.warn('web shell: service worker status unavailable', error?.message);
    });

  serviceWorker
    .register(new URL('sw.js', document.baseURI), { scope: './', updateViaCache: 'none' })
    .then(
      registration => {
        state.registered = true;
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          installing?.addEventListener('statechange', () => {
            if (installing.state === 'activated') {
              void checkLogged();
            }
          });
        });
        let lastUpdate = Date.now();
        const update = () => {
          lastUpdate = Date.now();
          registration.update().catch(() => undefined);
        };
        setInterval(update, CHECK_INTERVAL_MS);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && Date.now() - lastUpdate > CHECK_INTERVAL_MS / 6) {
            update();
          }
        });
        void checkLogged();
      },
      error => {
        state.error = String(error?.message ?? error);
        // oxlint-disable-next-line no-console
        console.warn('web shell: service worker registration failed', state.error);
      }
    );
  serviceWorker.addEventListener('controllerchange', () => void checkLogged());
}
