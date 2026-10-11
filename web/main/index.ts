// SPDX-License-Identifier: AGPL-3.0-only
//
// The web build's replacement for Electron's main process, running in the
// page: it answers the renderer's IPC (ipc.ts). Channels are grouped by
// what they do; channels.ts lists every channel the renderer uses and how
// the web build handles it.

import { createConfig } from './config.ts';
import { initFiles } from './files.ts';

export { onStorageFull } from './files.ts';
import { onSync, sendToRenderer } from './ipc.ts';
import { loadLocale } from './locale.ts';
import { installSettings } from './settings.ts';
import { installChannels } from './channels.ts';
import { installSql, mainSql } from './sql.ts';
import type { DatabaseResult } from './sql.ts';
import { getCarrier } from '../net/carrier.ts';

let markRendererLoaded: () => void = () => undefined;
const rendererLoaded = new Promise<void>(resolve => {
  markRendererLoaded = resolve;
});
let userDataPath = '';

/**
 * Called once Desktop's preload graph has run (Electron's 'ready-to-show').
 * Desktop's attachment channel (Electron main code) starts here: its
 * modules share the renderer's, which must be initialized first (e.g.
 * ts/Crypto.node.ts takes window.SignalContext when it loads).
 */
export async function onRendererLoaded(): Promise<void> {
  const { installAttachments } = await import('./attachments.ts');
  installAttachments({ configDir: userDataPath, sql: mainSql });
  markRendererLoaded();
}

/** Starts the in-page main process; resolves with how the database opened. */
export async function startMain(): Promise<{ database: Promise<DatabaseResult> }> {
  // The app's files (attachments, avatars, ...): Desktop's code asks
  // synchronous questions about them, answered from the tree read here.
  const files = initFiles();
  const locale = await loadLocale();
  await files;
  const config = createConfig(locale);

  onSync('get-config', () => config);
  onSync('locale-data', () => locale.messages);
  onSync('locale-display-names', () => locale.localeDisplayNames);
  onSync('country-display-names', () => locale.countryDisplayNames);

  const sqlSettled = installSql({ configDir: config.userDataPath, appVersion: config.version });
  userDataPath = config.userDataPath;
  installSettings();
  installChannels({ config });

  // Focus, as Electron's main process reports it for the window: Desktop
  // shows notifications only while the app is not active.
  const sendFocus = () =>
    sendToRenderer('set-window-focus', document.visibilityState === 'visible' && document.hasFocus());
  window.addEventListener('focus', sendFocus);
  window.addEventListener('blur', sendFocus);
  document.addEventListener('visibilitychange', sendFocus);
  void rendererLoaded.then(sendFocus);

  // Electron's main process shows the window once it is ready to show and
  // the database is ready (or failed to open); the window's 'show' events
  // become 'activate'. The browser's equivalent is the tab being visible.
  // The web build also waits for Tor: the first 'activate' starts the link
  // screen's QR code, whose first attempt has only 10 s, and Tor can take a
  // minute on a slow network. Until then the shell shows "Connecting..."
  // (web/shell/status.ts).
  void Promise.all([sqlSettled, rendererLoaded, getCarrier().ready()]).then(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        sendToRenderer('activate');
        sendToRenderer('set-media-playback-disabled', false);
      }
    };
    onVisible();
    document.addEventListener('visibilitychange', onVisible);
  });

  return { database: sqlSettled };
}
