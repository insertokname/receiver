// SPDX-License-Identifier: AGPL-3.0-only
//
// The `electron` module as seen by Desktop's renderer in the browser build.
// ipcRenderer talks to the in-page main process (web/main/); the window is
// not sandboxed, so contextBridge simply sets globals.

import { handle, ipcRenderer } from '../../main/ipc.ts';
import { registerProtocol } from '../../main/protocols.ts';

export { ipcRenderer };

// For Desktop's main-process modules the web build runs in the page
// (app/attachment_channel.main.ts): invoke handlers and protocol handlers.
export const ipcMain = {
  handle(channel: string, handler: (event: unknown, ...args: Array<any>) => unknown): void {
    handle(channel, handler);
  },
};

export const protocol = {
  handle(scheme: string, handler: (request: Request) => Promise<Response> | Response): void {
    registerProtocol(scheme, handler);
  },
};

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    (window as unknown as Record<string, unknown>)[key] = api;
  },
  exposeInIsolatedWorld(_worldId: number, key: string, api: unknown): void {
    (window as unknown as Record<string, unknown>)[key] = api;
  },
};

// Zoom is the browser's own (Ctrl +/-); the page cannot set it.
export const webFrame = {
  getZoomFactor: (): number => 1,
  setZoomFactor: (_factor: number): void => undefined,
  getZoomLevel: (): number => 0,
  setZoomLevel: (_level: number): void => undefined,
  setVisualZoomLevelLimits: (): Promise<void> => Promise.resolve(),
  setSpellCheckProvider: (): void => undefined,
  insertCSS: (): string => '',
  removeInsertedCSS: (): void => undefined,
  clearCache: (): void => undefined,
};

// Browsers do not expose file system paths of dropped or picked files.
export const webUtils = {
  getPathForFile: (_file: File): string => '',
};

export default { ipcRenderer, ipcMain, protocol, contextBridge, webFrame, webUtils };
