// SPDX-License-Identifier: AGPL-3.0-only
//
// A tab back from the background. While hidden, the browser throttles the
// page's timers (once a second, in Chromium later once a minute): the
// connections' own liveness checks keep time (the transport's timer
// worker), but a reconnect that was waiting for its backoff, Desktop's or
// Tor's, may be late. When the tab comes back after a while, connections are
// checked and reconnected at once, as Desktop does when the computer wakes
// up: the 'online' event Desktop already handles (SocketManager's
// onNavigatorOnline: a liveness check of every connection, an immediate
// reconnect if one was waiting; the Tor client retries too).

const CHECK_AFTER_HIDDEN_MS = 60_000;

export function installBackgroundReturn(): void {
  let hiddenSince = document.visibilityState === 'hidden' ? Date.now() : undefined;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenSince = Date.now();
      return;
    }
    const hiddenFor = hiddenSince === undefined ? 0 : Date.now() - hiddenSince;
    hiddenSince = undefined;
    if (hiddenFor >= CHECK_AFTER_HIDDEN_MS && navigator.onLine) {
      // oxlint-disable-next-line no-console
      console.log(`web shell: back after ${Math.round(hiddenFor / 1000)} s in the background, checking connections`);
      window.dispatchEvent(new Event('online'));
    }
  });
}
