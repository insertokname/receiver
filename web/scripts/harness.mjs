// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the browser runners: serve web/dist/site the way GitHub Pages
// does (under /receiver/) and drive it in headless Chromium.
//
// The page is loaded from http://pages.example:8080/receiver/ (pages.example
// mapped to 127.0.0.1 and treated as a secure context) so it has a real,
// non-localhost Origin like the deployment. github.io itself can't be used:
// it is HSTS-preloaded.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const SITE_DIR = fileURLToPath(new URL('../dist/site/', import.meta.url));
export const BASE_PATH = '/receiver/';
const HOST = 'pages.example';
const PORT = Number(process.env.PORT ?? 8080);
export const LOCAL_ORIGIN = `http://${HOST}:${PORT}`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.pem': 'text/plain',
  '.br': 'application/octet-stream',
};

/** Static server for SITE_DIR under BASE_PATH; anything else is 404. */
export function serveSite() {
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x');
      if (!pathname.startsWith(BASE_PATH)) throw new Error('outside base path');
      let path = normalize(join(SITE_DIR, decodeURIComponent(pathname.slice(BASE_PATH.length))));
      if (!path.startsWith(SITE_DIR)) throw new Error('path traversal');
      if (path.endsWith('/')) path = join(path, 'index.html');
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise(resolve => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/**
 * Launches headless Chromium ($CHROMIUM). With `blackholeHosts`, those hosts
 * resolve to 192.0.2.1 (TEST-NET-1, unroutable): connections to them hang
 * until the caller's timeout, like a blocked bridge.
 */
export async function launchBrowser({ blackholeHosts = [] } = {}) {
  if (!process.env.CHROMIUM) throw new Error('set CHROMIUM to a Chromium/Chrome executable');
  const rules = [`MAP ${HOST} 127.0.0.1`, ...blackholeHosts.map(h => `MAP ${h} 192.0.2.1`)];
  return puppeteer.launch({
    executablePath: process.env.CHROMIUM,
    headless: true,
    protocolTimeout: 0,
    args: [
      `--host-resolver-rules=${rules.join(', ')}`,
      `--unsafely-treat-insecure-origin-as-secure=${LOCAL_ORIGIN}`,
      ...(process.env.CI ? ['--no-sandbox'] : []),
    ],
  });
}

// The only hosts a page may contact directly besides its own origin: Tor
// entry points. Everything else goes through Tor. (WebRTC/STUN traffic is
// not visible here.)
export const ALLOWED_DIRECT_ORIGINS = [
  'wss://snowflake.torproject.net',
  'https://snowflake-broker.torproject.net',
];

/**
 * Records every direct network destination of the page (HTTP requests and
 * WebSockets) and every CSP violation. Call report() at the end: it prints
 * the destinations and returns a list of problems (empty = fine).
 */
export async function watchPage(page) {
  const destinations = new Map();
  const note = url => {
    const { origin, protocol } = new URL(url);
    if (protocol === 'data:' || protocol === 'blob:') return;
    destinations.set(origin, (destinations.get(origin) ?? 0) + 1);
  };
  page.on('request', r => note(r.url()));
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', e => note(e.url));
  await page.evaluateOnNewDocument(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', e =>
      window.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI}`)
    );
  });
  return {
    async report() {
      const pageOrigin = new URL(page.url()).origin;
      const problems = [];
      console.log('direct network destinations:');
      for (const [origin, count] of destinations) {
        const allowed = origin === pageOrigin || ALLOWED_DIRECT_ORIGINS.includes(origin);
        console.log(`  ${allowed ? 'ok        ' : 'FORBIDDEN '} ${origin} (${count})`);
        if (!allowed) problems.push(`page contacted ${origin} directly`);
      }
      const csp = await page.evaluate(() => window.__cspViolations ?? []).catch(() => []);
      for (const v of csp) problems.push(`CSP violation: ${v}`);
      console.log(`CSP violations: ${csp.length}`);
      return problems;
    },
  };
}

/** Forwards the page's console, errors and failed requests to stdout. */
export function pipePageOutput(page) {
  page.on('console', m => console.log(m.text()));
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('response', r => {
    if (r.status() >= 400) console.log('HTTP', r.status(), r.url());
  });
  page.on('requestfailed', r => {
    if (!r.url().startsWith('data:')) console.log('REQUESTFAILED', r.url(), r.failure()?.errorText);
  });
}
