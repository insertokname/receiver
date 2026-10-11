// SPDX-License-Identifier: AGPL-3.0-only
//
// The web build's replacement for Electron's main process, running in the
// page: it answers the renderer's IPC (ipc.ts). Channels are grouped by
// what they do; channels.ts lists every channel the renderer uses and how
// the web build handles it.

import { createConfig } from './config.ts';
import { onSync, sendToRenderer } from './ipc.ts';
import { loadLocale } from './locale.ts';
import { installSettings } from './settings.ts';
import { installChannels } from './channels.ts';
import { installSql } from './sql.ts';

let markRendererLoaded: () => void = () => undefined;
const rendererLoaded = new Promise<void>(resolve => {
  markRendererLoaded = resolve;
});

/** Called once Desktop's preload graph has run (Electron's 'ready-to-show'). */
export function onRendererLoaded(): void {
  markRendererLoaded();
}

export async function startMain(): Promise<void> {
  const locale = await loadLocale();
  const config = createConfig(locale);

  onSync('get-config', () => config);
  onSync('locale-data', () => locale.messages);
  onSync('locale-display-names', () => locale.localeDisplayNames);
  onSync('country-display-names', () => locale.countryDisplayNames);

  const sqlSettled = installSql({ configDir: config.userDataPath, appVersion: config.version });
  installSettings();
  installChannels({ config });

  // Electron's main process shows the window once it is ready to show and
  // the database is ready (or failed to open); the window's 'show' events
  // become 'activate'. The browser's equivalent is the tab being visible.
  void Promise.all([sqlSettled, rendererLoaded]).then(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        sendToRenderer('activate');
        sendToRenderer('set-media-playback-disabled', false);
      }
    };
    onVisible();
    document.addEventListener('visibilitychange', onVisible);
  });
}
