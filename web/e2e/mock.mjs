// SPDX-License-Identifier: AGPL-3.0-only
//
// Desktop's mock server (packages/mock-server, as ts/test-mock/ uses it),
// extended from here without changing the package: it also accepts
// WebSockets over HTTP/1.1 (Upgrade: websocket), which the web build's
// transport speaks and Signal's servers accept. The mock itself only
// accepts WebSockets over HTTP/2 (extended CONNECT, libsignal-net's way);
// both end up in the mock's own WebSocket connection handler.
//
// Calls the mock serves only over gRPC (multi-recipient send, usernames,
// upload forms, backups) are not used by the e2e scenarios; when they are,
// their REST routes can be added to each connection's router here
// (Connection keeps it in `router`).
//
// The package is built in place (git-ignored protos/compiled.js and
// src/**/*.js) by buildMockServer().

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { MOCK_SERVER_PACKAGE } from './config.mjs';

const require = createRequire(join(MOCK_SERVER_PACKAGE, 'package.json'));

/** Builds the mock server package in place (git-ignored output; tsc is incremental). */
export function buildMockServer() {
  const bin = name => join(MOCK_SERVER_PACKAGE, 'node_modules/.bin', name);
  execFileSync(bin('protopiler'), ['--module', 'cjs', '--output', 'protos/compiled.js', '--typedefs', 'protos/compiled.d.ts', 'protos'], {
    cwd: MOCK_SERVER_PACKAGE,
    stdio: 'inherit',
  });
  execFileSync(bin('tsc'), [], { cwd: MOCK_SERVER_PACKAGE, stdio: 'inherit' });
}

export function loadMockServer() {
  buildMockServer();
  const mock = require('./src/index.js');
  const { Connection } = require('./src/server/ws/connection.js');
  const { WebSocketServer } = require('ws');
  return { mock, Connection, WebSocketServer };
}

/**
 * Creates and starts a mock Server (`options` as in Server's constructor) on
 * 127.0.0.1 with the extensions above. Resolves to { server, port }.
 */
export async function startMockServer(options) {
  const { mock, Connection, WebSocketServer } = loadMockServer();
  const server = new mock.Server(options);
  await server.listen(0, '127.0.0.1');
  const { port } = server.address();

  const wss = new WebSocketServer({ noServer: true });
  wss.on('headers', headers => {
    for (const [name, value] of Object.entries(server.wsUpgradeResponseHeaders ?? {})) {
      headers.push(`${name}: ${value}`);
    }
  });
  // An Http2SecureServer with allowHTTP1 emits 'upgrade' for HTTP/1.1
  // upgrade requests; the mock does not listen for it.
  server.https.on('upgrade', (req, socket, head) => {
    if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const connection = new Connection(req, ws, server);
      connection.start(ws).catch(error => {
        console.log(`mock: WebSocket handling error: ${error?.stack ?? error}`);
        ws.close();
      });
    });
  });
  return { server, port, mock };
}
