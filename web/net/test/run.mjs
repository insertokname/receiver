// SPDX-License-Identifier: AGPL-3.0-only
//
// WebNet test in headless Chromium: the web build's libsignal Net and its
// HTTPS client, through real Tor, against Signal's real servers, under the
// app's CSP, at the deployment's path (http://pages.example:8080/receiver/).
// No real account is involved: authenticated checks use a random ACI and a
// bogus password.
//
//   (a) unauthenticated chat: GET /v1/keepalive -> 200
//   (b) authenticated chat with bogus credentials -> the error libsignal
//       gives Desktop for the server's answer (403 -> DeviceDelinked,
//       which Desktop's SocketManager turns into 'authError')
//   (c) provisioning connection: the server pushes an address, acked
//   (d) forced transport drop (the browser goes offline): the connection
//       reports onConnectionInterrupted within libsignal's idle timeout
//       (45 s), and after going online a reconnect succeeds
//   (e) onNetworkChange on a healthy connection keeps it
//   (f) HTTPS: an unauthenticated storage service request gets 401 with
//       TLS pinned to Signal's CA; a wrong CA is rejected; a request
//       without a pinned CA is refused
//   (g) CDSI and SVR2 reject with typed libsignal errors
//   (h) large uploads on a chat connection: two concurrent ~230 KB
//       prekey-shaped PUT /v2/keys (what Desktop sends right after linking)
//       and 1 MB more are all answered, and the connection stays healthy
//
// The test page (net/test/page.ts, bundled here) is served by this runner
// only. Needs the built site (scripts/build-site.sh).
//
//   node net/test/run.mjs

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

import { netAssetsPlugin } from '../../renderer/net-assets.mjs';
import { webResolvePlugin } from '../../renderer/resolve.mjs';
import { BASE_PATH, LOCAL_ORIGIN, SITE_DIR, launchBrowser, serveSite, watchPage } from '../../scripts/harness.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = join(HERE, '../..');
const REPO = join(WEB, '..');

// libsignal's idle timeout (WS_MAX_IDLE_INTERVAL) plus margin for the check interval.
const DROP_DETECTION_LIMIT_MS = 47_000;
const SECRET_PATTERNS = [/bogus-password-for-tests/, /Authorization: Basic/i];

const appHtml = await readFile(join(SITE_DIR, 'index.html'), 'utf8');
const csp = appHtml.match(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/)?.[0];
if (!csp) throw new Error('index.html has no CSP meta tag');
const wrongCa = await readFile(join(WEB, 'transport-test/wrong-ca.pem'), 'utf8');

const resolver = webResolvePlugin();
const netAssets = await netAssetsPlugin();
const bundle = await build({
  cwd: REPO,
  input: join(HERE, 'page.ts'),
  platform: 'browser',
  tsconfig: join(REPO, 'tsconfig.json'),
  write: false,
  transform: {
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_BUNDLED': 'true', global: 'globalThis' },
    inject: {
      process: 'node:process',
      Buffer: ['node:buffer', 'Buffer'],
      setImmediate: ['node:timers', 'setImmediate'],
      clearImmediate: ['node:timers', 'clearImmediate'],
    },
  },
  plugins: [resolver.plugin, netAssets.plugin],
  output: { format: 'esm', codeSplitting: false },
});
const pageJs = bundle.output[0].code;

// The page and its script live next to app.js, where libsignal's loader
// finds its WebAssembly.
const app = BASE_PATH;
const server = await serveSite({
  extra: {
    [`${app}net-test.html`]: [
      'text/html; charset=utf-8',
      `<!doctype html><html><head><meta charset="utf-8">${csp}<title>net test</title><script type="module" src="./net-test.js"></script></head><body></body></html>`,
    ],
    [`${app}net-test.js`]: ['text/javascript', pageJs],
  },
});
const browser = await launchBrowser();
const problems = [];
const logLines = [];

function check(condition, message) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) problems.push(message);
}

let ok = false;
try {
  const page = await browser.newPage();
  const watcher = await watchPage(page);
  page.on('console', m => {
    const text = m.text();
    logLines.push(text);
    console.log(`  | ${text.slice(0, 300)}`);
  });
  page.on('pageerror', e => problems.push(`uncaught exception: ${e.message}`));
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const setOffline = offline =>
    cdp.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  const run = (name, ...args) => page.evaluate((n, a) => window.netTest[n](...a), name, args);

  console.log(`net test: ${LOCAL_ORIGIN}${app}net-test.html`);
  const started = Date.now();
  await page.goto(`${LOCAL_ORIGIN}${app}net-test.html`);
  await page.waitForFunction(() => window.netTest, { timeout: 60_000 });
  await page.evaluate(() => window.netTest.ready);
  console.log(`Tor ready after ${((Date.now() - started) / 1000).toFixed(1)} s`);

  console.log('(a) unauthenticated chat');
  const a = await run('unauthenticatedKeepalive');
  console.log(`  ${JSON.stringify(a)}`);
  check(a.status === 200, `GET /v1/keepalive -> ${a.status} (connect ${a.connectMs} ms, request ${a.ms} ms)`);
  check(a.interruptions.length === 1 && a.interruptions[0].code === null, 'disconnect() reports a deliberate close (cause null)');

  console.log('(b) authenticated chat, bogus credentials');
  const b = await run('authenticatedBogus');
  console.log(`  ${JSON.stringify(b)}`);
  check(!b.connected && b.error?.code === 'DeviceDelinked', `refused with ${b.error?.code} (${b.error?.message})`);

  console.log('(c) provisioning');
  const c = await run('provisioning');
  console.log(`  ${JSON.stringify(c)}`);
  check(c.received?.length > 0 && c.received.acked, `provisioning address of ${c.received?.length} chars received and acked after ${c.ms} ms`);

  console.log('(e) network change on a healthy connection');
  const e = await run('networkChangeProbe');
  console.log(`  ${JSON.stringify(e)}`);
  check(e.status === 200 && e.interruptedBeforeDisconnect === 0, 'connection survives onNetworkChange (liveness check passed)');

  console.log('(f) HTTPS client');
  const f1 = await run('storageUnauthenticated');
  console.log(`  ${JSON.stringify(f1)}`);
  check(f1.status === 401 && f1.hasTimestamp, `storage.signal.org without credentials -> ${f1.status} (x-signal-timestamp: ${f1.hasTimestamp}, ${f1.ms} ms)`);
  const f2 = await run('storageWrongCa', wrongCa);
  console.log(`  ${JSON.stringify(f2)}`);
  check(f2.rejected && /UnknownIssuer|certificate/i.test(f2.error?.message ?? ''), `wrong CA rejected: ${f2.error?.message}`);
  const f3 = await run('noPinnedCa');
  console.log(`  ${JSON.stringify(f3)}`);
  check(f3.rejected && f3.error?.code === 'ERR_WEB_UNSUPPORTED', `request without a pinned CA refused: ${f3.error?.message}`);

  console.log('(g) not available yet');
  const g = await run('unavailable');
  console.log(`  ${JSON.stringify(g)}`);
  check(g.cdsiLookup?.name === 'LibSignalError' && g.svr2?.name === 'LibSignalError', 'CDSI and SVR2 reject with typed libsignal errors');

  console.log('(h) large uploads (prekey-sized requests, then 1 MB)');
  const h = await run('largeUploads');
  console.log(`  ${JSON.stringify(h)}`);
  check(
    !h.failed &&
    h.prekeyStatuses.every(s => s === 401) && h.bulkStatuses.every(s => s === 401) && h.keepaliveAfter === 200 && h.interruptedBeforeDisconnect === 0,
    h.failed ? `upload failed after ${h.afterMs} ms: ${h.failed.code} ${h.failed.message}` : `2 x ${Math.round(h.prekeyBytes[0] / 1024)} KB in ${(h.prekeyMs / 1000).toFixed(1)} s, 1 MB in ${(h.bulkMs / 1000).toFixed(1)} s, all answered; connection still healthy`
  );

  console.log('(d) forced transport drop');
  const d0 = await run('openForDrop');
  check(d0.status === 200, `connection open (keepalive ${d0.ms} ms)`);
  const droppedAt = await run('nowMs');
  await setOffline(true);
  const d1 = await Promise.race([
    run('awaitDropInterruption', droppedAt),
    new Promise(resolve => setTimeout(() => resolve(null), DROP_DETECTION_LIMIT_MS + 15_000)),
  ]);
  console.log(`  ${JSON.stringify(d1)}`);
  check(d1 !== null && d1.afterMs <= DROP_DETECTION_LIMIT_MS && d1.code === 'IoError', `onConnectionInterrupted(${d1?.code}) ${d1 ? `${(d1.afterMs / 1000).toFixed(1)} s` : 'never'} after the drop (${d1?.message})`);
  const onlineAt = await run('nowMs');
  await setOffline(false);
  const d2 = await run('reconnect', onlineAt);
  console.log(`  ${JSON.stringify(d2)}`);
  check(d2.ok, `reconnect succeeded ${(d2.afterMs / 1000).toFixed(1)} s after going online (${d2.attempts.length} failed attempts)`);

  const secrets = logLines.filter(l => SECRET_PATTERNS.some(p => p.test(l)));
  check(secrets.length === 0, `no credentials in the log (${logLines.length} lines)`);
  problems.push(...(await watcher.report()));
  ok = problems.length === 0;
} catch (error) {
  problems.push(error.stack ?? String(error));
} finally {
  for (const p of problems) console.log(`NET FAIL: ${p}`);
  console.log(problems.length === 0 && ok ? 'NET PASS' : 'NET FAIL');
  await browser.close();
  server.close();
}
process.exit(ok ? 0 : 1);
