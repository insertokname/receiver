// SPDX-License-Identifier: AGPL-3.0-only
//
// A local HTTP CONNECT proxy for the liveness tests (test-only): the browser
// reaches the Snowflake bridge through it, and blackholeAll() makes every
// open tunnel silently stop forwarding in both directions (no close, no
// error), like a bridge connection that stops delivering. New tunnels work,
// so the app can recover by connecting again. The proxy only sees TLS.

import http from 'node:http';
import net from 'node:net';

/**
 * Starts the proxy on 127.0.0.1 (a free port). Only `allowed` "host:port"
 * targets are tunnelled. Resolves to { port, blackholeAll(), close(), stats }.
 */
export async function startTunnelProxy({ allowed = ['snowflake.torproject.net:443'] } = {}) {
  const permitted = new Set(allowed);
  const tunnels = new Set();
  const stats = { tunnels: 0, refused: 0, blackholed: 0 };
  const server = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req, client, head) => {
    if (!permitted.has(req.url)) {
      stats.refused += 1;
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host);
    const tunnel = { client, upstream, dead: false };
    tunnels.add(tunnel);
    stats.tunnels += 1;
    const done = () => {
      tunnels.delete(tunnel);
      client.destroy();
      upstream.destroy();
    };
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.on('data', data => {
        if (!tunnel.dead) upstream.write(data);
      });
      upstream.on('data', data => {
        if (!tunnel.dead) client.write(data);
      });
    });
    client.on('error', done);
    client.on('close', done);
    upstream.on('error', done);
    upstream.on('close', done);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    stats,
    /** Every open tunnel stops forwarding (both directions) and stays open. */
    blackholeAll() {
      for (const tunnel of tunnels) {
        if (!tunnel.dead) stats.blackholed += 1;
        tunnel.dead = true;
      }
    },
    close() {
      for (const { client, upstream } of tunnels) {
        client.destroy();
        upstream.destroy();
      }
      return new Promise(resolve => server.close(resolve));
    },
  };
}
