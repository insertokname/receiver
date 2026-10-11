// SPDX-License-Identifier: AGPL-3.0-only
//
// Storage test page (served by sql/test/run.mjs only, never deployed): the
// in-page main process's database side (web/main/sql.ts) and the real SQL
// worker of the site, driven through the same IPC channels Desktop's
// renderer uses.

import { ipcRenderer } from '../../main/ipc.ts';
import { installSql } from '../../main/sql.ts';

declare global {
  interface Window {
    storageTest: {
      ready: Promise<unknown>;
      invoke(channel: string, ...args: Array<unknown>): Promise<unknown>;
    };
  }
}

window.storageTest = {
  ready: installSql({ configDir: '/userData', appVersion: '0.0.0-storage-test' }),
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
};
