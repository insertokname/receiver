// SPDX-License-Identifier: AGPL-3.0-only
//
// Connection status while Tor connects or reconnects, like WhatsApp Web's
// "Connecting..." (web/net/tor.ts publishes its state in <html data-tor>):
//
// - nothing of Desktop on screen yet (the link screen waits for Tor, see
//   web/main/index.ts): a "Connecting..." card in place of the screen;
// - on the link screen: a banner above it;
// - in the inbox Desktop's own network status (its left pane dialogs)
//   shows the state of its connection, so nothing is added.
//
// Builds whose carrier is not Tor (the end-to-end tests') set no data-tor
// and show nothing.
//
// The link screen's QR code: Desktop gives up after a connection error or
// a timeout and offers "Try again" (Electron apps reach Signal in well
// under its 10 s). Over Tor a connection can be slower, so, like WhatsApp
// Web reloading its code by itself, the shell retries Desktop's installer
// with backoff while showing "Connecting..." in place of the error. A QR
// code that expired unused (MaxRotations) is left to the user, as in
// Desktop and WhatsApp Web.

import { desktopView, everySecond, h } from './ui.ts';

const TEXT: Record<string, { title: string; detail: string }> = {
  starting: {
    title: 'Connecting...',
    detail: 'Connecting to Signal through the Tor network.',
  },
  bootstrapping: {
    title: 'Connecting...',
    detail: 'Connecting to Signal through the Tor network. On a slow network this can take a minute.',
  },
  retrying: {
    title: 'Not connected',
    detail: 'Could not reach the Tor network. Check your internet connection; receiver keeps trying.',
  },
};

type InstallerState = Readonly<{
  step?: string;
  error?: string;
  provisioningUrl?: Readonly<{ loadingState?: number; error?: string }>;
}>;

// ts/util/loadable.std.ts LoadingState.Loaded / LoadFailed.
const LOADED = 1;
const LOAD_FAILED = 2;
const RETRYABLE_INSTALL_ERRORS = new Set(['ConnectionFailed', 'QRCodeFailed']);
const RETRYABLE_QR_ERRORS = new Set(['Timeout', 'Unknown', 'NetworkIssue']);
const MAX_RETRY_DELAY_MS = 30_000;

function linkScreenFailed(): boolean {
  const state = window.reduxStore?.getState() as { app?: { appView?: string }; installer?: InstallerState } | undefined;
  const installer = state?.installer;
  if (state?.app?.appView !== 'Installer' || !installer) {
    return false;
  }
  if (installer.step === 'Error') {
    return RETRYABLE_INSTALL_ERRORS.has(installer.error ?? '');
  }
  return (
    installer.step === 'QrCodeNotScanned' &&
    installer.provisioningUrl?.loadingState === LOAD_FAILED &&
    RETRYABLE_QR_ERRORS.has(installer.provisioningUrl.error ?? '')
  );
}

function qrCodeShown(): boolean {
  const installer = (window.reduxStore?.getState() as { installer?: InstallerState } | undefined)?.installer;
  return installer?.step === 'QrCodeNotScanned' && installer.provisioningUrl?.loadingState === LOADED;
}

export function installConnectionStatus(): void {
  const title = h('span', { class: 'web-shell-status__title' });
  const detail = h('span', { class: 'web-shell-status__detail' });
  const element = h(
    'div',
    { class: 'web-shell web-shell-status', role: 'status', 'aria-live': 'polite', 'data-web-status': '' },
    h('span', { class: 'web-shell-spinner', 'aria-hidden': 'true' }),
    title,
    detail
  );

  let mounted = false;
  let waitingSince: number | undefined;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    const tor = document.documentElement.dataset.tor;
    // The browser knows it is offline: say so, whatever Tor is trying.
    let state = tor && tor !== 'ready' && !navigator.onLine ? 'retrying' : tor;
    let view = desktopView();
    if (linkScreenFailed()) {
      if (retryTimer === undefined) {
        const delay = Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** retries);
        retries += 1;
        // oxlint-disable-next-line no-console
        console.log(`web shell: the link screen could not get its code; trying again in ${delay / 1000} s`);
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          window.reduxActions?.installer.startInstaller();
        }, delay);
      }
      view = 'waiting';
      waitingSince ??= Date.now() - 1000;
      state = state === 'retrying' ? state : 'bootstrapping';
    } else if (qrCodeShown()) {
      retries = 0;
    }
    const text = state ? TEXT[state] : undefined;
    // A linked app is 'waiting' only for a moment before its inbox opens
    // (which does not wait for Tor): no card for that.
    waitingSince = view === 'waiting' ? (waitingSince ?? Date.now()) : undefined;
    const waitedLongEnough = waitingSince !== undefined && Date.now() - waitingSince >= 1000;
    // The shell's own full-window screens ("Use here", errors) take precedence.
    const shellScreen = document.documentElement.dataset.webScreen != null;
    const show = Boolean(text) && !shellScreen && (waitedLongEnough || view === 'install');
    if (!show || !text) {
      if (mounted) {
        element.remove();
        mounted = false;
        delete document.documentElement.dataset.webStatus;
      }
      return;
    }
    const mode = view === 'install' ? 'banner' : 'card';
    element.className = `web-shell web-shell-status web-shell-status--${mode}`;
    title.textContent = text.title;
    detail.textContent = text.detail;
    if (!mounted) {
      document.body.append(element);
      mounted = true;
    }
    document.documentElement.dataset.webStatus = `${mode}:${state}`;
  };

  // Also on every state change of Desktop's store, so that a link screen
  // error is covered before it is painted.
  let subscribed = false;
  everySecond(() => {
    if (!subscribed && window.reduxStore) {
      subscribed = true;
      window.reduxStore.subscribe(update);
    }
    update();
  });
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  new MutationObserver(update).observe(document.documentElement, { attributeFilter: ['data-tor'] });
}
