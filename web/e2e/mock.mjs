// SPDX-License-Identifier: AGPL-3.0-only
//
// Desktop's mock server (packages/mock-server, as ts/test-mock/ uses it),
// extended from here without changing the package: it also accepts
// WebSockets over HTTP/1.1 (Upgrade: websocket), which the web build's
// transport speaks and Signal's servers accept. The mock itself only
// accepts WebSockets over HTTP/2 (extended CONNECT, libsignal-net's way);
// both end up in the mock's own WebSocket connection handler.
//
// For fault tests, `onEvent` sees every request as it arrives: WebSocket
// upgrades, requests on the chat WebSockets, plain HTTPS requests (CDNs,
// storage service) and messages the server pushes to a device. Like
// Signal's server: a device's new authenticated socket ends its old one
// (aborted if it does not close), and messages the old one never got
// acknowledged go to the new one. CDN 3 attachments are served here, with
// Range requests (206), which the mock does not support.
//
// Calls the mock serves only over gRPC (multi-recipient send, usernames,
// upload forms, backups) are not used by the e2e scenarios; when they are,
// their REST routes can be added to each connection's router here
// (Connection keeps it in `router`).
//
// The package is built in place (git-ignored protos/compiled.js and
// src/**/*.js) by buildMockServer().

import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, normalize } from 'node:path';

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
 * GET /cdn3/attachments/<key>, as CDN 3 answers it: 200, or 206 for a Range
 * request. (The mock's own route has no Range support and crashes when a
 * client goes away mid-download.)
 */
async function serveCdn3Attachment(cdn3Path, req, res) {
  const match = /^\/cdn3\/attachments\/([^/?]+)$/.exec(req.url);
  if (req.method !== 'GET' || !match || !cdn3Path) return false;
  const file = normalize(join(cdn3Path, 'attachments', match[1]));
  let size;
  try {
    ({ size } = await stat(file));
  } catch {
    res.writeHead(404).end();
    return true;
  }
  const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  const start = range ? Number(range[1]) : 0;
  if (range && start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
    return true;
  }
  res.writeHead(range ? 206 : 200, {
    'Content-Length': size - start,
    ...(range ? { 'Content-Range': `bytes ${start}-${size - 1}/${size}` } : {}),
  });
  const stream = createReadStream(file, { start });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
  return true;
}

/**
 * Creates and starts a mock Server (`options` as in Server's constructor) on
 * 127.0.0.1 with the extensions above. Resolves to { server, port }.
 * `onDeviceLink` sees the account attributes of every device link request
 * (PUT /v1/devices/link), e.g. its encrypted device name. `onEvent` gets
 * { type: 'upgrade' | 'ws' | 'http' | 'push', method, path, authenticated?, range? } for
 * every request when it arrives.
 */
export async function startMockServer({ onDeviceLink, onEvent = () => undefined, ...options } = {}) {
  const { mock, Connection, WebSocketServer } = loadMockServer();
  const server = new mock.Server(options);
  await server.listen(0, '127.0.0.1');
  const { port } = server.address();

  const send = server.send.bind(server);
  server.send = (target, message) => {
    onEvent({ type: 'push', method: 'PUT', path: '/api/v1/message', target });
    return send(target, message);
  };

  // A device's new authenticated socket replaces the old one: the mock
  // closes the old one politely, which never completes on a hung
  // connection; abort it soon, as the server would.
  const addWebSocket = server.addWebSocket.bind(server);
  server.addWebSocket = (device, socket) => {
    const existing = server.webSockets.get(device);
    if (existing && existing !== socket) setTimeout(() => existing.ws.terminate(), 1000);
    return addWebSocket(device, socket);
  };
  const deliverQueued = () => {
    for (const [device, socket] of server.webSockets) {
      if (server.messageQueue.get(device)?.length && socket.ws.readyState === 1) void server.sendQueue(device, socket);
    }
  };

  const handlers = server.https.listeners('request');
  server.https.removeAllListeners('request');
  server.https.on('request', (req, res) => {
    onEvent({ type: 'http', method: req.method, path: req.url, range: req.headers.range });
    serveCdn3Attachment(options.cdn3Path, req, res).then(
      served => {
        if (!served) for (const handler of handlers) handler.call(server.https, req, res);
      },
      error => {
        console.log(`mock: range request failed: ${error?.stack ?? error}`);
        res.destroy();
      }
    );
  });

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
    onEvent({ type: 'upgrade', method: 'GET', path: req.url, authenticated: Boolean(req.headers.authorization) });
    wss.handleUpgrade(req, socket, head, ws => {
      const connection = new Connection(req, ws, server);
      // Messages that failed on this socket (the mock queues them) go to
      // the device's current socket, if it has one.
      ws.once('close', () => setTimeout(deliverQueued, 10));
      const run = connection.router.run.bind(connection.router);
      connection.router.run = request => {
        onEvent({ type: 'ws', method: request.verb, path: request.path });
        return run(request);
      };
      if (onDeviceLink) {
        for (const route of connection.router.routes) {
          if (route.method === 'PUT' && route.pattern.match('/v1/devices/link')) {
            const { handler } = route;
            route.handler = (params, body, headers) => {
              try {
                onDeviceLink(JSON.parse(Buffer.from(body).toString()).accountAttributes);
              } catch {
                // The mock's handler reports a malformed body.
              }
              return handler(params, body, headers);
            };
          }
        }
      }
      connection.start(ws).catch(error => {
        console.log(`mock: WebSocket handling error: ${error?.stack ?? error}`);
        ws.close();
      });
    });
  });
  return { server, port, mock };
}
