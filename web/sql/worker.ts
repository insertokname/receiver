// SPDX-License-Identifier: AGPL-3.0-only
//
// Entry point of the SQL worker (sql/worker.js, started by web/main/sql.ts):
// Desktop's database code in a Web Worker, on encrypted SQLite in the
// origin private file system. Desktop's SQL code imports libsignal (random
// bytes, service ids), so libsignal's WebAssembly is loaded first (the same
// file the page loads, checked against the same digest), then the request
// handling (server.ts). Requests are handled one at a time, in order:
// Desktop's SQL code is synchronous and 'init' must finish first.

import { initLibsignal } from '@signalapp/libsignal-client/wasm/index.js';
import assets from 'virtual:web-sql-assets';

import { fetchModule } from './assets.ts';
import { respondError, scope } from './respond.ts';

const server = (async () => {
  const libsignal = await fetchModule(assets.libsignal, scope.location.href);
  await initLibsignal({ wasm: libsignal });
  return import('./server.ts');
})();

let queue = Promise.resolve();
scope.addEventListener('message', event => {
  const message = event.data;
  queue = queue.then(async () => {
    let handler: Awaited<typeof server>;
    try {
      handler = await server;
    } catch (error) {
      respondError(message.seq, error);
      return;
    }
    await handler.onMessage(message);
  });
});
