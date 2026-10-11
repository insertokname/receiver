// SPDX-License-Identifier: AGPL-3.0-only
//
// The end-to-end tests' relay (test-only, never deployed): accepts
// WebSockets from the e2e build's carrier (web/e2e/relay-carrier.ts) at
// ws://127.0.0.1:<port>/?host=<host>&port=<port> and pipes their bytes to
// the mock server's TCP port. It only relays to the mock server: the target
// must be one of `targets` ("host:port" the app may ask for), every one of
// which goes to 127.0.0.1:<mockPort>. It never sees plaintext: TLS runs end
// to end between the app and the mock server.
//
// Faults, like those of a Tor circuit: dropAll() closes every connection;
// stallAll() makes every open connection silently stop forwarding (no
// close, like a circuit that hangs); stallNew(true) does the same to new
// connections until turned off; refuseFor(ms) fails new connections right
// away for a while (like a Tor client being replaced); afterBytesDown(n,
// fn) runs fn once n more bytes went to the app (e.g. to drop a download
// half way), afterBytesUp(n, fn) once n more bytes came from it (an upload).

import { createRequire } from 'node:module';
import net from 'node:net';
import { join } from 'node:path';

import { MOCK_SERVER_PACKAGE } from './config.mjs';

// The `ws` package the mock server itself uses.
const { WebSocketServer } = createRequire(join(MOCK_SERVER_PACKAGE, 'package.json'))('ws');

/**
 * Starts the relay on 127.0.0.1:`port`. Only pages from `origin` may use it.
 * Resolves to { close(), dropAll(), stallAll(), stallNew(), afterBytesDown(),
 * stats } where stats counts connections, bytes and faults.
 */
export async function startRelay({ port, origin, targets, mockPort }) {
  const allowed = new Set(targets);
  const stats = { accepted: 0, refused: 0, open: 0, bytesUp: 0, bytesDown: 0, dropped: 0, stalled: 0 };
  const connections = new Set();
  let stallingNew = false;
  let refuseUntil = 0;
  let byteTriggers = [];
  let upTriggers = [];

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
    if (Date.now() < refuseUntil) {
      stats.refused += 1;
      ws.terminate();
      return;
    }
    stats.accepted += 1;
    stats.open += 1;
    const tcp = net.connect(mockPort, '127.0.0.1');
    const connection = { ws, tcp, stalled: false };
    connections.add(connection);
    if (stallingNew) {
      connection.stalled = true;
      stats.stalled += 1;
    }
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      connections.delete(connection);
      stats.open -= 1;
      tcp.destroy();
      ws.terminate();
    };
    ws.on('message', data => {
      if (connection.stalled) return;
      stats.bytesUp += data.length;
      tcp.write(data);
      if (upTriggers.length) {
        const due = upTriggers.filter(t => stats.bytesUp >= t.at);
        upTriggers = upTriggers.filter(t => stats.bytesUp < t.at);
        for (const trigger of due) setImmediate(trigger.fn);
      }
    });
    tcp.on('data', chunk => {
      if (connection.stalled) return;
      stats.bytesDown += chunk.length;
      ws.send(chunk);
      if (byteTriggers.length) {
        const due = byteTriggers.filter(t => stats.bytesDown >= t.at);
        byteTriggers = byteTriggers.filter(t => stats.bytesDown < t.at);
        for (const trigger of due) setImmediate(trigger.fn);
      }
    });
    tcp.on('error', done);
    tcp.on('close', done);
    ws.on('error', done);
    ws.on('close', done);
  });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  return {
    stats,
    /** Drops every relayed connection (as if the network went away). */
    dropAll() {
      for (const { ws, tcp } of connections) {
        stats.dropped += 1;
        ws.terminate();
        tcp.destroy();
      }
    },
    /** Every open connection stops forwarding, in both directions, without closing. */
    stallAll() {
      for (const connection of connections) {
        if (!connection.stalled) stats.stalled += 1;
        connection.stalled = true;
      }
    },
    /** While on, new connections are stalled from the start. */
    stallNew(on) {
      stallingNew = on;
    },
    /** New connections fail at once for `ms`. */
    refuseFor(ms) {
      refuseUntil = Date.now() + ms;
    },
    /** Runs `fn` once `bytes` more bytes went from the mock server to the app. */
    afterBytesDown(bytes, fn) {
      byteTriggers.push({ at: stats.bytesDown + bytes, fn });
    },
    /** Runs `fn` once `bytes` more bytes went from the app to the mock server. */
    afterBytesUp(bytes, fn) {
      upTriggers.push({ at: stats.bytesUp + bytes, fn });
    },
    close() {
      for (const { ws, tcp } of connections) {
        ws.terminate();
        tcp.destroy();
      }
      return new Promise(resolve => wss.close(resolve));
    },
  };
}
