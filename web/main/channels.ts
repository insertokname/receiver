// SPDX-License-Identifier: AGPL-3.0-only
//
// Every IPC channel Desktop's main window uses (besides config, locale and
// settings, see index.ts / settings.ts), and what the web build does with
// it. Main -> renderer events ('show-window', 'power-channel:suspend', ...)
// need no handler; the web main sends the ones that apply.
//
// "stub" channels are explicit: they answer a safe value (or reject with a
// clear error) and log once that they were used. The database channels are
// in sql.ts; the network-backed ones belong to Phase 4.

import type { RendererConfigType } from '../../ts/types/RendererConfig.std.ts';
import { handle, logOnce, onSend, onSync, sendToRenderer, stub } from './ipc.ts';
import { clearLog } from './logs.ts';

class NotAvailableError extends Error {
  override name = 'NotAvailableInWebBuildError';
}

function reject(what: string): () => never {
  return () => {
    throw new NotAvailableError(`${what} is not available in the web build`);
  };
}

export function installChannels({ config }: { config: RendererConfigType }): void {
  // Synchronous queries.
  onSync('OS.getClassName', () => 'os-linux');
  onSync('get-user-data-path', () => config.userDataPath);

  // Window and app shell. The browser owns the window: these are no-ops.
  handle('getMainWindowStats', () => ({
    isMaximized: false,
    isFullScreen: document.fullscreenElement != null,
  }));
  handle('getMenuOptions', () => ({
    development: false,
    devTools: false,
    includeSetup: false,
    isNightly: false,
    isProduction: true,
    platform: 'linux',
  }));
  handle('getZoomFactor', () => 1);
  onSend('setZoomFactor', () => undefined);
  stub('invoke', 'executeMenuRole', undefined, 'there is no application menu');
  for (const channel of [
    'add-setup-menu-items',
    'remove-setup-menu-items',
    'set-auto-hide-menu-bar',
    'set-menu-bar-visibility',
    'title-bar-double-click',
    'update-tray-icon',
    'bounce-app-icon-start',
    'bounce-app-icon-stop',
    'draw-attention',
    'ready-for-updates',
    'set-is-call-active',
    'start-tracking-query-stats',
    'stop-tracking-query-stats',
    'requested-close-confirmation',
    'received-close-confirmation',
    'now-ready-for-shutdown',
    'settings:response',
  ]) {
    onSend(channel, () => undefined);
  }
  onSend('show-window', () => window.focus());
  onSend('restart', () => window.location.reload());
  onSend('shutdown', () => undefined);
  onSend('signal-app-loaded', () => {
    document.documentElement.dataset.appLoaded = 'true';
  });

  // Unread count in the tab title, like WhatsApp Web: "(3) receiver".
  onSend('set-badge-count', (_event, count: unknown) => {
    const n = typeof count === 'number' && count > 0 ? count : 0;
    const base = document.title.replace(/^\(\d+\) /, '');
    document.title = n > 0 ? `(${n}) ${base}` : base;
  });

  // DB-backed settings changed in the renderer: notify listeners (Electron
  // main relays this to every window).
  onSend('preferences-changed', () => sendToRenderer('preferences-changed'));

  // Clipboard: copying uses the browser's clipboard; clearing it afterwards
  // would need clipboard read permission to check the content, so it is left
  // to the user.
  onSend('SignalClipboard.copyTextTemporarily', (_event, text: unknown) => {
    if (typeof text === 'string') {
      navigator.clipboard?.writeText(text).catch(error => {
        // oxlint-disable-next-line no-console
        console.warn('web main: clipboard write failed', error?.name);
      });
    }
  });
  stub('send', 'SignalClipboard.clear', undefined, 'clearing the clipboard needs read permission');
  stub('send', 'SignalClipboard.clearIfNeeded', undefined, 'clearing the clipboard needs read permission');

  // Updates: the site is the update; a reload picks up the latest build.
  stub('invoke', 'start-update', undefined, 'updates come with the site');
  stub('invoke', 'updater/force-check', undefined, 'updates come with the site');

  // OS integration that does not exist in a browser.
  handle('get-auto-launch', () => false);
  stub('invoke', 'set-auto-launch', undefined, 'no auto launch in a browser');
  handle('get-media-access-status', () => undefined);
  stub('invoke', 'open-system-media-permissions', undefined, 'the browser manages camera and microphone permissions');
  stub('invoke', 'show-permissions-popup', undefined, 'the browser asks for permissions itself');
  stub('invoke', 'windows-notifications:show', undefined, 'Windows only');
  stub('invoke', 'windows-notifications:clear-all', undefined, 'Windows only');
  onSend('prompt-os-auth', (_event, request: { reason?: string } | undefined) => {
    sendToRenderer(`prompt-os-auth:${String(request?.reason)}`, 'unsupported');
  });
  stub('invoke', 'cleanup-downloads', undefined, 'downloads are the browser\'s');
  stub('send', 'show-item-in-folder', undefined, 'no file manager in a browser');
  stub('invoke', 'crash-reports:get-count', 0, 'no native crash reports');
  stub('invoke', 'crash-reports:erase', undefined, 'no native crash reports');
  stub('invoke', 'crash-reports:write-to-log', undefined, 'no native crash reports');

  // Files: Phase 5 (downloads via the browser, OPFS for app data).
  handle('show-save-dialog', reject('saving files'));
  handle('show-open-folder-dialog', reject('choosing folders'));
  handle('pdf:generate', reject('PDF export'));

  // Logs: kept in memory (logs.ts). Uploading needs the network (Phase 4).
  handle('delete-all-logs', () => clearLog());
  handle('fetch-log', reject('the debug log view'));
  handle('DebugLogs.getLogs', reject('the debug log view'));
  handle('DebugLogs.upload', reject('debug log upload'));

  // Optional resources (large emoji font, localized emoji search, calling
  // sounds) are downloaded by Electron's main process from Signal's update
  // server; the web build will ship or fetch them through Tor later. Until
  // then the localized emoji search index is empty (emoji search uses the
  // built-in English names) and everything else is unavailable.
  handle('OptionalResourceService:getData', (_event, name: unknown) => {
    if (typeof name === 'string' && /^emoji-index-[\w-]+\.json$/.test(name)) {
      logOnce('optional-resources:emoji-index', 'localized emoji search data is not in the web build yet; emoji search uses English names');
      return new TextEncoder().encode('[]');
    }
    return reject('optional resources')();
  });

  // Secondary windows and calling: not in the web build yet.
  for (const channel of [
    'show-debug-log',
    'close-debug-log',
    'show-call-diagnostic',
    'close-call-diagnostic',
    'update-call-diagnostic-data',
    'close-about',
    'show-settings',
    'show-screen-share',
    'screen-share:status-change',
    'art-creator:onUploadProgress',
  ]) {
    stub('send', channel, undefined, 'secondary windows and calling are not in the web build yet');
  }

  // Captcha challenges (Phase 4) and HEIC conversion (needs a worker).
  stub('send', 'challenge:request', undefined, 'captcha challenges come with the network layer');
  onSend('convert-image', (_event, uuid: unknown) => {
    sendToRenderer(`convert-image:${String(uuid)}`, {
      error: new NotAvailableError('HEIC conversion is not available in the web build'),
    });
  });
}
