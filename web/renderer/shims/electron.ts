// SPDX-License-Identifier: AGPL-3.0-only
//
// The `electron` module as seen by Desktop's renderer in the browser build.
// ipcRenderer talks to the in-page main process (web/main/); the window is
// not sandboxed, so contextBridge simply sets globals.

import { ipcRenderer } from '../../main/ipc.ts';

export { ipcRenderer };

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

export default { ipcRenderer, contextBridge, webFrame, webUtils };
