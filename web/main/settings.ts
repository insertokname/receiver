// SPDX-License-Identifier: AGPL-3.0-only
//
// Ephemeral settings and the system theme, as ts/main/settingsChannel.main.ts
// and NativeThemeNotifier.main.ts do in Electron. Values live in
// localStorage (storage.ts); spell checking is the browser's and stays off
// by default.

import { handle, onSync, sendToRenderer } from './ipc.ts';
import { getStored, setStored } from './storage.ts';

type ThemeSetting = 'light' | 'dark' | 'system';

const DEFAULTS = {
  themeSetting: 'system',
  systemTraySetting: 'DoNotUseSystemTray',
  localeOverride: null,
  spellCheck: false,
  contentProtection: false,
} as const;

type EphemeralName = keyof typeof DEFAULTS;

const darkQuery = matchMedia('(prefers-color-scheme: dark)');

export function prefersDark(): boolean {
  return darkQuery.matches;
}

export function getThemeSetting(): ThemeSetting {
  const value = getStored<string>('themeSetting');
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : 'system';
}

function nativeThemeState() {
  return {
    shouldUseDarkColors: prefersDark(),
  };
}

export function installSettings(): void {
  for (const name of Object.keys(DEFAULTS) as Array<EphemeralName>) {
    handle(`settings:get:${name}`, () => getStored(name) ?? DEFAULTS[name]);
    handle(`settings:set:${name}`, (_event, value: unknown) => {
      setStored(name, value);
      sendToRenderer(`settings:update:${name}`, value);
    });
  }

  // Camera and microphone permissions are the browser's to grant; the
  // stored preference only records what the user chose in the app.
  handle('settings:get:mediaPermissions', () => getStored('mediaPermissions') ?? false);
  handle('settings:get:mediaCameraPermissions', () => getStored('mediaCameraPermissions'));
  handle('settings:set:mediaPermissions', (_event, value: unknown) => {
    setStored('mediaPermissions', value);
  });
  handle('settings:set:mediaCameraPermissions', (_event, value: unknown) => {
    setStored('mediaCameraPermissions', value);
  });

  onSync('native-theme:init', () => nativeThemeState());
  darkQuery.addEventListener('change', () => {
    sendToRenderer('native-theme:changed', nativeThemeState());
  });
}
