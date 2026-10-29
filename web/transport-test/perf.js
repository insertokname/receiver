// SPDX-License-Identifier: AGPL-3.0-only
//
// Transport measurements over real Snowflake/Tor (run by perf.mjs, which
// serves this page; it is not part of the site). Only production code paths
// and Signal's own hosts, TLS pinned to Signal's CA: the chat server
// (unauthenticated requests, no account) and the update server
// updates2.signal.org (Desktop's public release files, which answer Range
// requests) as a large-download target.
//
// Reports (window.__perf):
//   bootstrap      connectTor, with the time of each stage from webtor's log
//   chatConnect    new chat WebSocket (Tor stream + TLS + upgrade), seconds
//   rttIdle        request round trips on an idle chat socket (GET /v1/keepalive)
//   httpsNew       HTTPS time to response head on a new connection
//   httpsReused    the same on a kept-alive connection
//   downloads      for each mode: MB, seconds, time to first byte, MB/s overall
//                  and after the first second, and chat round trips meanwhile
//   hidden         the same download and round trips with the page hidden
//                  (the runner hides it: Chromium and Firefox throttle the
//                  timers of hidden pages to 1 Hz)
//
//   circuits       circuit build times and the circuits in use (builds that
//                  report them)
//   memory         the transport's WebAssembly memory (MB) after loading,
//                  after bootstrap and at the end; with cross-origin
//                  isolation (perf.mjs MEMORY=1) also the page's total
//                  (performance.measureUserAgentSpecificMemory)
//
// Query parameters: sizeMB=16, modes=single,parallel, hidden, rtts=10, lanes=4,
// cc=0 (fixed window instead of congestion control)

import * as transport from '../transport/index.js';
import { CHAT_URL, request } from '../lib/signal.js';

const { connectTor, errorReason, onTransportLog, openSignalSocket, SIGNAL_CA_PEM, SignalHttps, sleep, TRANSPORTS, withDeadline } =
  transport;

const params = new URLSearchParams(location.search);
const SIZE = Number(params.get('sizeMB') ?? 16) * 1024 * 1024;
const MODES = (params.get('modes') ?? 'single,parallel').split(',');
const HIDDEN = params.has('hidden');
const RTTS = Number(params.get('rtts') ?? 10);
const LANES = Number(params.get('lanes') ?? 4);
// cc=0: Tor's fixed window instead of congestion control (builds that have it)
const CONGESTION_CONTROL = params.get('cc') !== '0';
const UPDATES = 'https://updates2.signal.org/desktop/';

const out = document.getElementById('out');
const t0 = performance.now();
const secs = (from, to = performance.now()) => Math.round(to - from) / 1000;
function log(...parts) {
  const line = `[${secs(t0)}s] ${parts.join(' ')}`;
  out.textContent += line + '\n';
  console.log(line);
}

const perf = { userAgent: navigator.userAgent, sizeMB: SIZE / 1024 / 1024, congestionControl: CONGESTION_CONTROL, errors: [] };

// Bootstrap stages, from webtor's log lines.
const STAGES = [
  ['directory', /Tor directory from .* verified|Using the Tor directory verified earlier/],
  ['websocket', /WebSocket connected/],
  ['bridge', /Connected to Snowflake bridge/],
  ['channel', /Channel established/],
  ['circuit', /Circuit created|Circuit established successfully/],
];
const stages = {};
const webtorLines = [];
onTransportLog((level, target, message) => {
  for (const [name, pattern] of STAGES) {
    if (!(name in stages) && pattern.test(message)) stages[name] = secs(t0);
  }
  if (/WARN|ERROR/i.test(level)) webtorLines.push(`${level} ${message.slice(0, 200)}`);
});

async function keepalive(socket, timeoutMs = 60_000) {
  const started = performance.now();
  const response = await request(socket, 'GET', '/v1/keepalive', { timeoutMs });
  if (response.status !== 200) throw new Error(`keepalive status ${response.status}`);
  return secs(started);
}

/** A GET through `https`; reads the whole body, recording when bytes arrived. */
async function get(https, url, headers = [], { onPiece } = {}) {
  const started = performance.now();
  const response = await https.request('GET', url, headers, undefined, SIGNAL_CA_PEM, 60_000);
  const head = performance.now();
  let bytes = 0;
  let firstByte;
  let afterOneSecond;
  try {
    for (;;) {
      const piece = await response.body.next(60_000);
      if (!piece) break;
      firstByte ??= performance.now();
      bytes += piece.byteLength;
      if (afterOneSecond === undefined && performance.now() - firstByte >= 1000) {
        afterOneSecond = { at: performance.now(), bytes };
      }
      onPiece?.(bytes);
    }
  } finally {
    response.body.free?.();
  }
  const end = performance.now();
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    ttfb: secs(started, head),
    seconds: secs(started, end),
    steadyMBps:
      afterOneSecond && end > afterOneSecond.at
        ? Math.round(((bytes - afterOneSecond.bytes) / 1024 / 1024 / ((end - afterOneSecond.at) / 1000)) * 1000) / 1000
        : undefined,
  };
}

/** Desktop's current Linux release file (a ~140 MB file that answers Range requests). */
async function bigFile(https) {
  const response = await https.request('GET', `${UPDATES}latest-linux.yml`, [], undefined, SIGNAL_CA_PEM, 60_000);
  if (response.status !== 200) throw new Error(`latest-linux.yml: HTTP ${response.status}`);
  let text = '';
  for (let piece; (piece = await response.body.next(60_000)); ) text += new TextDecoder().decode(piece);
  const path = text.match(/^path: (\S+)$/m)?.[1];
  if (!path) throw new Error('no path in latest-linux.yml');
  return `${UPDATES}${path}`;
}

/** Round trips on `socket` every second until `done` settles. */
async function rttsWhile(socket, done) {
  const rtts = [];
  let finished = false;
  done.finally(() => {
    finished = true;
  });
  while (!finished) {
    try {
      rtts.push(await keepalive(socket));
    } catch (error) {
      rtts.push(null);
      perf.errors.push(`keepalive during download: ${errorReason(error)}`);
    }
    if (!finished) await Promise.race([sleep(1000), done.catch(() => undefined)]);
  }
  return rtts;
}

async function download(mode, https, url, socket) {
  const headers = [['Range', `bytes=0-${SIZE - 1}`]];
  const job =
    mode === 'parallel'
      ? (async () => {
          const started = performance.now();
          const response = await transport.fetchRanged(https, {
            url,
            headers,
            rootPem: SIGNAL_CA_PEM,
            timeoutMs: 60_000,
            lanes: LANES,
          });
          const head = performance.now();
          let bytes = 0;
          let firstByte;
          let afterOneSecond;
          for (;;) {
            const piece = await response.body.next(60_000);
            if (!piece) break;
            firstByte ??= performance.now();
            bytes += piece.byteLength;
            if (afterOneSecond === undefined && performance.now() - firstByte >= 1000) {
              afterOneSecond = { at: performance.now(), bytes };
            }
          }
          const end = performance.now();
          return {
            status: response.status,
            lanes: response.stats?.(),
            bytes,
            ttfb: secs(started, head),
            seconds: secs(started, end),
            steadyMBps: afterOneSecond
              ? Math.round(((bytes - afterOneSecond.bytes) / 1024 / 1024 / ((end - afterOneSecond.at) / 1000)) * 1000) / 1000
              : undefined,
          };
        })()
      : get(https, url, headers);
  const rtts = rttsWhile(socket, job);
  const result = await job;
  if (result.bytes !== SIZE) throw new Error(`${mode}: got ${result.bytes} of ${SIZE} bytes (HTTP ${result.status})`);
  return {
    mode,
    status: result.status,
    MB: Math.round((result.bytes / 1024 / 1024) * 100) / 100,
    seconds: result.seconds,
    ttfb: result.ttfb,
    MBps: Math.round((result.bytes / 1024 / 1024 / result.seconds) * 1000) / 1000,
    steadyMBps: result.steadyMBps,
    chatRtts: await rtts,
    ...(result.lanes ? { lanes: result.lanes } : {}),
  };
}

async function measure(label, fn) {
  try {
    return await fn();
  } catch (error) {
    perf.errors.push(`${label}: ${errorReason(error)}`);
    log('ERROR', label, errorReason(error));
    return undefined;
  }
}

async function hide() {
  console.log('ACTION hide');
  const asked = performance.now();
  while (document.visibilityState !== 'hidden') {
    if (performance.now() - asked > 10_000) throw new Error('the page was not hidden (runner: perf.mjs)');
    await sleep(50);
  }
  // Let the browser apply its hidden-page timer policy.
  await sleep(2000);
}

const MB = bytes => (bytes === undefined ? undefined : Math.round((bytes / 1024 / 1024) * 10) / 10);

/** The transport's WebAssembly memory, and the page's total when the browser can measure it. */
async function memory() {
  const result = { transportMB: MB(transport.transportMemoryBytes?.()) };
  if (globalThis.crossOriginIsolated && performance.measureUserAgentSpecificMemory) {
    try {
      const measured = await performance.measureUserAgentSpecificMemory();
      result.pageMB = MB(measured.bytes);
    } catch (error) {
      perf.errors.push(`measureUserAgentSpecificMemory: ${errorReason(error)}`);
    }
  }
  return result;
}

async function run() {
  log('measuring:', MODES.join(','), `${SIZE / 1024 / 1024} MB`, HIDDEN ? '(and hidden)' : '');
  const loadStarted = performance.now();
  await transport.loadTransport();
  perf.wasmLoad = secs(loadStarted);
  perf.memory = { afterLoad: await memory() };
  const bootStarted = performance.now();
  const { client } = await connectTor({
    transports: [TRANSPORTS.find(t => t.name === 'snowflake-websocket')],
    rounds: 3,
    congestionControl: CONGESTION_CONTROL,
    onEvent: e => {
      if (e.type === 'failed') {
        perf.errors.push(`bootstrap attempt failed after ${e.seconds.toFixed(1)}s: ${e.reason}`);
        log('bootstrap attempt failed:', e.reason);
      }
    },
  });
  perf.bootstrap = { seconds: secs(bootStarted), stages };
  log('Tor ready', JSON.stringify(perf.bootstrap));
  perf.memory.afterBootstrap = await memory();
  log('memory', JSON.stringify(perf.memory));

  const https = new SignalHttps(client);
  try {
    perf.chatConnect = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const s = await measure('chat connect', () => openSignalSocket(client, CHAT_URL));
      if (!s) continue;
      perf.chatConnect.push(secs(started));
      await s.close().catch(() => undefined);
    }
    const socket = await openSignalSocket(client, CHAT_URL);
    perf.rttIdle = [];
    for (let i = 0; i < RTTS; i++) {
      const rtt = await measure('keepalive', () => keepalive(socket));
      if (rtt !== undefined) perf.rttIdle.push(rtt);
    }
    log('chat connect', perf.chatConnect.join(' '), '| idle round trips', perf.rttIdle.join(' '));

    const url = await bigFile(https);
    perf.httpsNew = [];
    perf.httpsReused = [];
    for (let i = 0; i < 3; i++) {
      https.clear();
      const fresh = await measure('https new', () => get(https, `${UPDATES}latest-linux.yml`));
      if (fresh) perf.httpsNew.push(fresh.ttfb);
      const reused = await measure('https reused', () => get(https, `${UPDATES}latest-linux.yml`));
      if (reused) perf.httpsReused.push(reused.ttfb);
    }
    log('https time to head: new', perf.httpsNew.join(' '), '| reused', perf.httpsReused.join(' '));

    const modes = MODES.filter(mode => mode !== 'parallel' || typeof transport.fetchRanged === 'function');
    perf.downloads = [];
    for (const mode of modes) {
      const result = await measure(`download ${mode}`, () => download(mode, https, url, socket));
      if (result) {
        perf.downloads.push(result);
        log(`download ${mode}:`, JSON.stringify(result));
      }
    }

    if (HIDDEN) {
      await hide();
      log('page hidden');
      perf.hidden = { downloads: [], rttIdle: [] };
      for (let i = 0; i < Math.min(RTTS, 5); i++) {
        const rtt = await measure('keepalive hidden', () => keepalive(socket));
        if (rtt !== undefined) perf.hidden.rttIdle.push(rtt);
      }
      for (const mode of modes) {
        const result = await measure(`hidden download ${mode}`, () => download(mode, https, url, socket));
        if (result) {
          perf.hidden.downloads.push(result);
          log(`hidden download ${mode}:`, JSON.stringify(result));
        }
      }
    }
    await socket.close().catch(() => undefined);
    if (typeof client.circuitStats === 'function') perf.circuits = await client.circuitStats();
    perf.memory.atEnd = await memory();
    log('memory', JSON.stringify(perf.memory));
  } finally {
    https.clear();
    await client.close().catch(() => undefined);
  }
}

try {
  await withDeadline(run(), 20 * 60_000, 'measurements did not finish within 20 minutes');
} catch (error) {
  perf.errors.push(errorReason(error));
  log('FAILED', errorReason(error));
}
perf.webtorWarnings = webtorLines.slice(0, 50);
window.__perf = perf;
log('DONE');
