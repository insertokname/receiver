// SPDX-License-Identifier: AGPL-3.0-only
//
// The end-to-end tests' relay (test-only, never deployed): accepts
// WebSockets from the e2e build's carrier (web/e2e/relay-carrier.ts) at
// ws://127.0.0.1:<port>/?host=<host>&port=<port> and pipes their bytes to
// the mock server's TCP port. It only relays to the mock server: the target
// must be one of `targets` ("host:port" the app may ask for), every one of
// which goes to 127.0.0.1:<mockPort>. It never sees plaintext: TLS runs end
// to end between the app and the mock server.

import { createRequire } from 'node:module';
import net from 'node:net';
import { join } from 'node:path';

import { MOCK_SERVER_PACKAGE } from './config.mjs';

// The `ws` package the mock server itself uses.
const { WebSocketServer, createWebSocketStream } = createRequire(join(MOCK_SERVER_PACKAGE, 'package.json'))('ws');

/**
 * Starts the relay on 127.0.0.1:`port`. Only pages from `origin` may use it.
 * Resolves to { close(), stats } where stats counts accepted and refused
 * connections.
 */
export async function startRelay({ port, origin, targets, mockPort }) {
  const allowed = new Set(targets);
  const stats = { accepted: 0, refused: 0, open: 0, bytesUp: 0, bytesDown: 0 };
  const sockets = new Set();
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    verifyClient: ({ origin: from, req }) => {
      const url = new URL(req.url, 'ws://relay');
      const target = `${url.searchParams.get('host')}:${url.searchParams.get('port')}`;
      const ok = from === origin && allowed.has(target);
      if (!ok) {
        stats.refused += 1;
        console.log(`relay: refused ${target} from ${from}`);
      }
      return ok;
    },
  });
  wss.on('connection', ws => {
    stats.accepted += 1;
    stats.open += 1;
    const tcp = net.connect(mockPort, '127.0.0.1');
    const stream = createWebSocketStream(ws);
    sockets.add(tcp);
    const done = () => {
      tcp.destroy();
      stream.destroy();
    };
    tcp.on('data', chunk => (stats.bytesDown += chunk.length));
    stream.on('data', chunk => (stats.bytesUp += chunk.length));
    tcp.on('error', done);
    stream.on('error', done);
    tcp.on('close', () => {
      sockets.delete(tcp);
      stats.open -= 1;
      ws.close();
    });
    stream.on('close', done);
    stream.pipe(tcp).pipe(stream);
  });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  return {
    stats,
    /** Drops every relayed connection (as if the network went away). */
    dropAll() {
      for (const ws of wss.clients) ws.terminate();
      for (const tcp of sockets) tcp.destroy();
    },
    close() {
      for (const ws of wss.clients) ws.terminate();
      return new Promise(resolve => wss.close(resolve));
    },
  };
}
