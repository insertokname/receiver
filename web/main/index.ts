// SPDX-License-Identifier: AGPL-3.0-only
//
// The web build's replacement for Electron's main process, running in the
// page: it answers the renderer's IPC (ipc.ts). Channels are grouped by
// what they do; channels.ts lists every channel the renderer uses and how
// the web build handles it.

import { createConfig } from './config.ts';
import { onSync } from './ipc.ts';
import { loadLocale } from './locale.ts';
import { installSettings } from './settings.ts';
import { installChannels } from './channels.ts';

export async function startMain(): Promise<void> {
  const locale = await loadLocale();
  const config = createConfig(locale);

  onSync('get-config', () => config);
  onSync('locale-data', () => locale.messages);
  onSync('locale-display-names', () => locale.localeDisplayNames);
  onSync('country-display-names', () => locale.countryDisplayNames);

  installSettings();
  installChannels({ config });
}
