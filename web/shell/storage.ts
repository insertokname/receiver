// SPDX-License-Identifier: AGPL-3.0-only
//
// Keeping the app's data, and noticing when the browser did not:
//
// - Right after the app is linked (when there is data worth keeping), the
//   browser is asked once to keep its storage (navigator.storage.persist();
//   Firefox shows a prompt for it). Never on a first visit. The outcome is
//   remembered: if it was refused, nothing is shown and it is not asked
//   again (WhatsApp Web does not nag either); the app works the same.
// - Safari deletes a site's storage after 7 days without use unless the
//   site is installed (Dock / Home Screen): the link screen says so. Where
//   the browser offers to install the app, the link screen offers it too.
// - Wiped data: if this browser had a linked app ('linked' in
//   localStorage) but the database had to be created anew (its files or
//   key were removed, e.g. by clearing site data or storage pressure), the
//   app explains that and goes to the link screen, instead of looking like
//   a first start.
//
// Plus the "unofficial client" notice under the link screen.

import { getStored, setStored } from '../main/storage.ts';
import { desktopView, everySecond, h, notice, showScreen } from './ui.ts';

const LINKED_KEY = 'linked';

type BeforeInstallPromptEvent = Event & { prompt(): Promise<unknown> };

function isStandalone(): boolean {
  return (
    matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isSafari(): boolean {
  return navigator.vendor === 'Apple Computer, Inc.' && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
}

// Not in storage.ts's settings: "delete all data" must not make the app ask again.
const PERSIST_ASKED_KEY = 'receiver-storage-persist-asked';

declare global {
  interface Window {
    // Read by the end-to-end tests.
    __webPersist?: { asked: boolean; persisted?: boolean };
  }
}

async function askToPersistOnce(): Promise<void> {
  const state: NonNullable<Window['__webPersist']> = { asked: false };
  window.__webPersist = state;
  if (!navigator.storage?.persist || !navigator.storage.persisted) {
    return;
  }
  state.persisted = await navigator.storage.persisted();
  let askedBefore = false;
  try {
    askedBefore = localStorage.getItem(PERSIST_ASKED_KEY) != null;
  } catch {
    // Without localStorage: ask (at most once per linking).
  }
  if (state.persisted || askedBefore) {
    return;
  }
  state.asked = true;
  state.persisted = await navigator.storage.persist();
  try {
    localStorage.setItem(PERSIST_ASKED_KEY, state.persisted ? 'granted' : 'denied');
  } catch {
    // Remembered for this page only.
  }
  // oxlint-disable-next-line no-console
  console.log(`web shell: persistent storage ${state.persisted ? 'granted' : 'not granted'}`);
}

/** Called once the database is open: tells the user if it was wiped. */
export function checkForWipedData(created: boolean): void {
  if (!created || getStored<boolean>(LINKED_KEY) !== true) {
    return;
  }
  // oxlint-disable-next-line no-console
  console.warn('web shell: the app was linked, but its database is gone; asking to link again');
  setStored(LINKED_KEY, false);
  const hide = showScreen({
    id: 'data-wiped',
    title: 'Your messages on this device were removed',
    text: [
      "The browser deleted receiver's data, for example because site data was cleared or the device ran low on storage.",
      'Link this device again from your phone to keep using receiver. Your phone still has your messages.',
    ],
    buttons: [{ label: 'Link again', testId: 'link-again', onClick: () => hide() }],
  });
}

export function installStorageGuards(): void {
  let installPrompt: BeforeInstallPromptEvent | undefined;
  window.addEventListener('beforeinstallprompt', event => {
    // Offered on the link screen instead of the browser's own mini bar.
    event.preventDefault();
    installPrompt = event as BeforeInstallPromptEvent;
    footer?.remove();
    footer = undefined;
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = undefined;
    footer?.remove();
    footer = undefined;
  });

  let footer: HTMLElement | undefined;
  let linkedSeen = false;
  everySecond(() => {
    const view = desktopView();
    if (view === 'inbox' && !linkedSeen) {
      linkedSeen = true;
      if (getStored<boolean>(LINKED_KEY) !== true) {
        // Just linked (or linked before this was recorded).
        setStored(LINKED_KEY, true);
        void askToPersistOnce().catch(() => undefined);
      }
    }
    const show =
      (view === 'install' || document.documentElement.dataset.webStatus?.startsWith('card:') === true) &&
      document.documentElement.dataset.webScreen == null;
    if (!show) {
      footer?.remove();
      footer = undefined;
      return;
    }
    if (footer) {
      return;
    }
    let hint: HTMLElement | null = null;
    if (installPrompt && !isStandalone()) {
      const prompt = installPrompt;
      const button = h('button', { type: 'button', class: 'web-shell-banner__link', 'data-testid': 'install-app' }, 'Install receiver as an app');
      button.addEventListener('click', () => {
        void prompt.prompt().finally(() => {
          installPrompt = undefined;
          footer?.remove();
          footer = undefined;
        });
      });
      hint = h('p', {}, button);
    } else if (isSafari() && !isStandalone()) {
      hint = h(
        'p',
        {},
        'Safari deletes website data after 7 days without use. To keep your messages, add receiver to your Dock (File > Add to Dock) or Home Screen (Share > Add to Home Screen) and use it from there.'
      );
    }
    footer = h('div', { class: 'web-shell web-shell-footer', 'data-web-footer': '' }, hint, notice());
    document.body.append(footer);
  });
}
