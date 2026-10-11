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
import jsQR from 'jsqr';
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
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ogg': 'audio/ogg',
};

/**
 * Static server for `siteDir` (default SITE_DIR; a function is asked on
 * every request) under BASE_PATH; anything else is 404. `extra` maps paths
 * to [content type, body] served in addition (test pages that are not part
 * of the site). `onRequest` sees every request's path.
 */
export function serveSite({ extra = {}, siteDir = SITE_DIR, onRequest } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x');
      onRequest?.(pathname);
      const root = typeof siteDir === 'function' ? siteDir() : siteDir;
      if (Object.hasOwn(extra, pathname)) {
        const [type, body] = extra[pathname];
        res.writeHead(200, { 'content-type': type });
        res.end(body);
        return;
      }
      if (!pathname.startsWith(BASE_PATH)) throw new Error('outside base path');
      let path = normalize(join(root, decodeURIComponent(pathname.slice(BASE_PATH.length))));
      if (!path.startsWith(root)) throw new Error('path traversal');
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
export async function watchPage(page, { allowedOrigins = ALLOWED_DIRECT_ORIGINS } = {}) {
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
        const allowed = origin === pageOrigin || allowedOrigins.includes(origin);
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

/**
 * Draws the rendered QR code (an inline SVG) onto a canvas with a white quiet
 * zone, decodes it with jsQR and checks it is Desktop's link URL
 * (ts/util/signalRoutes.std.ts linkDeviceRoute, ts/textsecure/Provisioner).
 * Resolves to { ok: true, url, summary, decoded } or { ok: false, reason }.
 *
 * Desktop's code leaves its centre empty for the logo and relies on error
 * correction; jsQR cannot read some of these codes (neither from a perfect
 * rasterization of their modules). Then the link is read from the props of
 * the component that drew the code (the same string), `decoded` is false
 * and the summary says so.
 */
export async function decodeLinkQrCode(page, selector, { timeoutMs = 3_000 } = {}) {
  // The code can be caught mid-render (it fades in): retry for a while.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const result = await decodeOnce(page, selector);
    if (result.ok || result.reason !== 'jsQR could not decode it') return result;
    if (Date.now() > deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const link = await page
    .evaluate(selector => {
      const svg = document.querySelector(selector);
      const key = svg && Object.keys(svg).find(k => k.startsWith('__reactFiber$'));
      for (let fiber = key ? svg[key] : null; fiber; fiber = fiber.return) {
        const link = fiber.memoizedProps?.link;
        if (typeof link === 'string') return link;
      }
      return null;
    }, selector)
    .catch(() => null);
  if (!link) return { ok: false, reason: 'jsQR could not decode it, and the link was not found in the component' };
  const result = checkLinkUrl(link);
  return result.ok ? { ...result, decoded: false, summary: `${result.summary} (from the QR component: jsQR could not read this code)` } : result;
}

// Desktop's code has round modules and a logo in the middle; jsQR reads
// some of them only at some scales, so several are tried.
const QR_RENDER_SIZES = [400, 330, 470];

async function decodeOnce(page, selector) {
  let decoded;
  for (const size of QR_RENDER_SIZES) {
    // eslint-disable-next-line no-await-in-loop
    const pixels = await page
      .evaluate(
        async (selector, size) => {
          const svg = document.querySelector(selector);
          if (!svg) return null;
          const img = new Image();
          img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
          await img.decode();
          const margin = Math.round(size / 10);
          const canvas = document.createElement('canvas');
          canvas.width = size + 2 * margin;
          canvas.height = size + 2 * margin;
          const context = canvas.getContext('2d');
          context.fillStyle = '#fff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.imageSmoothingEnabled = false;
          context.drawImage(img, margin, margin, size, size);
          const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
          let binary = '';
          for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
          return { data: btoa(binary), width, height };
        },
        selector,
        size
      )
      .catch(error => ({ error: error.message }));
    if (!pixels) return { ok: false, reason: 'not rendered' };
    if (pixels.error) return { ok: false, reason: `could not read the image: ${pixels.error}` };
    decoded = jsQR(new Uint8ClampedArray(Buffer.from(pixels.data, 'base64')), pixels.width, pixels.height);
    if (decoded) break;
  }
  if (!decoded) return { ok: false, reason: 'jsQR could not decode it' };
  const result = checkLinkUrl(decoded.data);
  return result.ok ? { ...result, decoded: true } : result;
}

/** Checks that `text` is Desktop's link URL. */
function checkLinkUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'not a URL' };
  }
  const uuid = url.searchParams.get('uuid');
  const pubKey = url.searchParams.get('pub_key');
  const capabilities = url.searchParams.get('capabilities');
  const key = pubKey ? Buffer.from(pubKey, 'base64') : Buffer.alloc(0);
  const problems = [];
  if (url.protocol !== 'sgnl:' || url.host !== 'linkdevice') problems.push(`unexpected URL ${url.protocol}//${url.host}`);
  // The provisioning address the server pushed: an opaque base64 token.
  if (!uuid || !/^[A-Za-z0-9+/_=-]{16,}$/.test(uuid)) {
    problems.push(`missing or malformed uuid (provisioning address): ${uuid ? `${uuid.length} chars, ${uuid.replace(/[A-Za-z0-9]/g, '')}` : 'absent'}`);
  }
  if (key.length !== 33 || key[0] !== 0x05) problems.push(`pub_key is not a 33-byte Curve25519 public key (${key.length} bytes)`);
  if (capabilities == null) problems.push('missing capabilities');
  if (problems.length) return { ok: false, reason: problems.join('; ') };
  return {
    ok: true,
    url: text,
    summary: `sgnl://linkdevice?uuid=<${uuid.length} chars>&pub_key=<33-byte key>&capabilities=${capabilities}`,
  };
}
