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
// acknowledged go to the new one; keys uploaded again are accepted. CDN 3
// attachments are served here, with Range requests (206), which the mock
// does not support, and interrupted uploads can be resumed (tus HEAD and
// PATCH).
//
// Calls the mock serves only over gRPC (multi-recipient send, usernames,
// upload forms, backups) have no REST routes in the mock; the web build's
// Net sends them as REST over the chat WebSocket, as Signal's server
// accepts them. Those the scenarios use are added to each connection's
// router here (Connection keeps it in `router`), on the mock's own logic:
// GET /v4/attachments/form/upload (Server.getAttachmentUploadForm, as its
// gRPC GetUploadForm). Uploads then go to CDN 3, the mock's tus server.
//
// The package is built in place (git-ignored protos/compiled.js and
// src/**/*.js) by buildMockServer().

import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, normalize } from 'node:path';

import { randomUUID } from 'node:crypto';

import { MOCK_SERVER_PACKAGE, MOCK_URL } from './config.mjs';

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
 * HEAD and PATCH /cdn3/attachments/<key>/<key>: resuming a tus upload, as
 * CDN 3 does. The mock's tus server takes the upload's id from the last
 * path segment for these, so it never finds an upload it created as
 * `attachments/<key>`; its file store's data and record are used here.
 */
async function resumeCdn3Upload(cdn3Path, req, res) {
  // Desktop's tus client addresses the upload as <upload location>/<key>.
  const match = /^\/cdn3\/attachments\/([^/?]+)\/\1$/.exec(req.url);
  if (!match || !cdn3Path || (req.method !== 'HEAD' && req.method !== 'PATCH')) return false;
  const file = normalize(join(cdn3Path, 'attachments', match[1]));
  let length;
  let offset;
  try {
    ({ size: length } = JSON.parse(await readFile(`${file}.json`, 'utf8')));
    ({ size: offset } = await stat(file));
  } catch (error) {
    console.log(`mock: no upload to resume: ${error.message}`);
    req.resume();
    res.writeHead(404, { 'Tus-Resumable': '1.0.0' }).end();
    return true;
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Tus-Resumable': '1.0.0', 'Upload-Offset': offset, 'Upload-Length': length, 'Cache-Control': 'no-store' }).end();
    return true;
  }
  if (Number(req.headers['upload-offset']) !== offset) {
    req.resume();
    res.writeHead(409, { 'Tus-Resumable': '1.0.0' }).end();
    return true;
  }
  const out = createWriteStream(file, { flags: 'a' });
  req.pipe(out);
  await new Promise(resolve => out.on('close', resolve));
  const { size } = await stat(file);
  res.writeHead(204, { 'Tus-Resumable': '1.0.0', 'Upload-Offset': size }).end();
  return true;
}

/**
 * Creates and starts a mock Server (`options` as in Server's constructor) on
 * 127.0.0.1 with the extensions above. Resolves to { server, port }.
 * `onDeviceLink` sees the account attributes of every device link request
 * (PUT /v1/devices/link), e.g. its encrypted device name. `onEvent` gets
 * { type: 'upgrade' | 'ws' | 'http' | 'push', method, path, authenticated?, range? } for
 * every request when it arrives. `profileAvatars` maps an ACI to
 * { path, data }: that profile has an avatar (the mock has none), served
 * encrypted at CDN 0's `/<path>` as Signal's CDN serves profile avatars.
 */
export async function startMockServer({ onDeviceLink, onEvent = () => undefined, profileAvatars = new Map(), ...options } = {}) {
  const { mock, Connection, WebSocketServer } = loadMockServer();
  const server = new mock.Server(options);
  await server.listen(0, '127.0.0.1');
  const { port } = server.address();

  const send = server.send.bind(server);
  server.send = (target, message) => {
    onEvent({ type: 'push', method: 'PUT', path: '/api/v1/message', target });
    return send(target, message);
  };

  // Uploading the same keys again (a retry whose first answer was lost) is
  // fine for Signal's server; the mock's linking bookkeeping asserts it
  // sees each kind once, after it stored the keys. Same keys, so success.
  const updateDeviceKeys = server.updateDeviceKeys.bind(server);
  server.updateDeviceKeys = async (...args) => {
    try {
      return await updateDeviceKeys(...args);
    } catch (error) {
      if (/^Duplicate service id kind /.test(error?.message ?? '')) return undefined;
      throw error;
    }
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
    onEvent({
      type: 'http',
      method: req.method,
      path: req.url,
      range: req.headers.range,
      chunked: req.headers['transfer-encoding'] === 'chunked',
      length: req.headers['content-length'],
      offset: req.headers['upload-offset'],
    });
    const avatar = req.method === 'GET' ? [...profileAvatars.values()].find(a => `/${a.path}` === req.url) : undefined;
    if (avatar) {
      res.writeHead(200, { 'Content-Length': avatar.data.length, 'Content-Type': 'application/octet-stream' }).end(avatar.data);
      return;
    }
    serveCdn3Attachment(options.cdn3Path, req, res)
      .then(served => served || resumeCdn3Upload(options.cdn3Path, req, res))
      .then(
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
      // Matched before the mock's own routes (its catch-all answers 404).
      connection.router.get('/v4/attachments/form/upload', async () => {
        const form = await server.getAttachmentUploadForm('attachments', randomUUID());
        // The mock names its own port; the app reaches the mock as MOCK_URL.
        return [200, { ...form, signedUploadLocation: `${MOCK_URL}/cdn3/attachments/${form.key}` }];
      });
      connection.router.routes.unshift(connection.router.routes.pop());
      for (const route of connection.router.routes) {
        const isProfile = ['/v1/profile/a', '/v1/profile/a/b', '/v1/profile/a/b/c'].some(path => route.pattern.match(path));
        if (route.method === 'GET' && isProfile) {
          const { handler } = route;
          route.handler = async (params, body, headers, query) => {
            const [status, json, ...rest] = await handler(params, body, headers, query);
            const avatar = profileAvatars.get(String(params.serviceId));
            return status === 200 && avatar ? [status, { ...json, avatar: avatar.path }, ...rest] : [status, json, ...rest];
          };
        }
      }
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
