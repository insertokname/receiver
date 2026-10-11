// SPDX-License-Identifier: AGPL-3.0-only
//
// One window at a time, like WhatsApp Web's "Use here".
//
// The SQL worker of the window that has the database holds the Web Lock
// 'receiver:database' (web/sql/storage.ts), so two windows can never write
// at once. This module makes the hand-over quick and visible:
//
// - The window using the app also holds the lock 'receiver:window' (the
//   page itself, from the moment it decides to start, before its worker
//   has the database lock).
// - At start, before anything else, a window checks whether that lock is
//   held. If it is, it asks on a BroadcastChannel whether a window is using
//   the app. A window that answers is open elsewhere: this one shows
//   "receiver is open in another window" with a "Use here" button and
//   starts nothing (no database, no Tor).
// - "Use here" asks the other window to release the database. That window
//   closes its database (the SQL worker's close request, which releases the
//   lock), confirms, and reloads, which ends its Signal connections; after
//   the reload it finds this window using the app and shows the same screen.
// - Nobody answers (the lock holder is a reload's old page shutting down, or
//   a frozen or crashed window): the app starts and its worker waits for the
//   lock (up to 5 s); if it still can't get it, the app shows the screen
//   (web/shell/errors.ts) and "Use here" reloads and asks again.

import { showScreen } from './ui.ts';

const CHANNEL = 'receiver:tabs';
const WINDOW_LOCK = 'receiver:window';
const USE_HERE_FLAG = 'receiver:use-here';
// How long to wait for an answer from a window that is using the app.
const PING_TIMEOUT_MS = 400;
// How long to wait for the other window to close its database, once it
// said it is doing so.
const RELEASE_TIMEOUT_MS = 8000;

type TabMessage =
  | { type: 'ping'; id: string }
  | { type: 'alive'; id: string }
  | { type: 'release'; id: string }
  | { type: 'releasing'; id: string }
  | { type: 'released'; id: string };

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : undefined;
let releaseHandler: (() => Promise<void>) | undefined;
let active = false;

function send(message: TabMessage): void {
  channel?.postMessage(message);
}

function waitFor(type: TabMessage['type'], id: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    if (!channel) {
      resolve(false);
      return;
    }
    const onMessage = (event: MessageEvent<TabMessage>) => {
      if (event.data?.type === type && event.data.id === id) {
        done(true);
      }
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    function done(result: boolean) {
      clearTimeout(timer);
      channel?.removeEventListener('message', onMessage);
      resolve(result);
    }
    channel.addEventListener('message', onMessage);
  });
}

async function lockHeld(): Promise<boolean> {
  try {
    const state = await navigator.locks.query();
    return (state.held ?? []).some(lock => lock.name === WINDOW_LOCK);
  } catch {
    return false;
  }
}

/** Asks the window using the app to let go of it; resolves when it did (or timed out). */
async function requestRelease(): Promise<number> {
  const started = performance.now();
  const id = crypto.randomUUID();
  const releasing = waitFor('releasing', id, PING_TIMEOUT_MS * 2);
  const released = waitFor('released', id, RELEASE_TIMEOUT_MS);
  send({ type: 'release', id });
  if (await releasing) {
    await released;
  }
  return Math.round(performance.now() - started);
}

/**
 * Resolves once this window may use the app: right away when no other
 * window uses it, otherwise after the user chose "Use here" and the other
 * window released the database.
 */
export async function claimTab(): Promise<void> {
  let useHere = false;
  try {
    useHere = sessionStorage.getItem(USE_HERE_FLAG) != null;
    sessionStorage.removeItem(USE_HERE_FLAG);
  } catch {
    // Storage disabled: no "Use here" after a reload, the lock still protects.
  }
  if (useHere) {
    await requestRelease();
  } else if (navigator.locks && (await lockHeld())) {
    const id = crypto.randomUUID();
    const answered = waitFor('alive', id, PING_TIMEOUT_MS);
    send({ type: 'ping', id });
    if (await answered) {
      await new Promise<void>(resolve => {
        showOpenElsewhere(async button => {
          button.disabled = true;
          const ms = await requestRelease();
          document.documentElement.dataset.webUseHereMs = String(ms);
          resolve();
        });
      });
      hideScreen?.();
    }
  }
  becomeActive();
}

let hideScreen: (() => void) | undefined;

function showOpenElsewhere(onUseHere: (button: HTMLButtonElement) => void): void {
  hideScreen = showScreen({
    id: 'open-elsewhere',
    title: 'receiver is open in another window',
    text: ["Click 'Use here' to use it in this window."],
    buttons: [{ label: 'Use here', testId: 'use-here', onClick: onUseHere }],
  });
}

/**
 * The database could not be opened because another window has it and did
 * not answer (frozen, or still closing): the same screen; "Use here"
 * reloads and asks that window again.
 */
export function showInUse(): void {
  showOpenElsewhere(() => {
    try {
      sessionStorage.setItem(USE_HERE_FLAG, '1');
    } catch {
      // Without session storage the reload just tries again.
    }
    window.location.reload();
  });
}

/** What the app does when another window takes over (closes the database). */
export function onRelease(handler: () => Promise<void>): void {
  releaseHandler = handler;
}

function becomeActive(): void {
  if (active) {
    return;
  }
  active = true;
  // Held until the page unloads. Taken over from a window that did not
  // answer (frozen or closing); the database lock is never taken over.
  navigator.locks
    ?.request(WINDOW_LOCK, { steal: true }, () => new Promise<void>(() => undefined))
    .catch(() => undefined);
  channel?.addEventListener('message', (event: MessageEvent<TabMessage>) => {
    const message = event.data;
    if (message?.type === 'ping') {
      send({ type: 'alive', id: message.id });
    } else if (message?.type === 'release') {
      send({ type: 'releasing', id: message.id });
      void release(message.id);
    }
  });
}

let releasing = false;

async function release(id: string): Promise<void> {
  if (releasing) {
    return;
  }
  releasing = true;
  document.documentElement.dataset.webReleased = 'true';
  try {
    await releaseHandler?.();
  } catch (error) {
    // oxlint-disable-next-line no-console
    console.error('web shell: closing the database for another window failed', error);
  }
  send({ type: 'released', id });
  // The reload ends this window's Signal connections and workers; afterwards
  // it finds the other window using the app and offers "Use here".
  window.location.reload();
}
