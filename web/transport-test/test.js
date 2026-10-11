// SPDX-License-Identifier: AGPL-3.0-only
//
// Browser checks for the Tor transport: can this static page reach Signal's
// chat server through Tor, securely (TLS pinned to Signal's CA) and robustly?
//
// Query parameters:
//   suites=ws,webrtc,chain  which transports to test (default: ws)
//                           ws = Snowflake WebSocket bridge, webrtc = Snowflake
//                           volunteer proxy, chain = the full fallback chain
//                           the app uses (reports which transport won)
//   only=basic,bulk,hold    which checks to run (default: basic)
//                           bulk downloads ~2.7 MB from a third party through
//                           Tor and hold keeps a connection open for minutes;
//                           both only run when asked for explicitly
//   hold=<minutes>  keepaliveSecs=<n>
//   autorun                 start without waiting for the button

import {
  connectTor,
  errorReason,
  onTransportLog,
  openSignalSocket,
  SignalSocket,
  TRANSPORTS,
  withDeadline,
} from '../transport/index.js';
import { CHAT_URL, receiveProvisioningAddress, request } from '../lib/signal.js';

const params = new URLSearchParams(location.search);
const SUITES = (params.get('suites') ?? 'ws').split(',');
const ONLY = (params.get('only') ?? 'basic').split(',');
const HOLD_MINUTES = Number(params.get('hold') ?? 5);
const KEEPALIVE_SECS = Number(params.get('keepaliveSecs') ?? 30);
const want = name => ONLY.includes(name);

const out = document.getElementById('out');
const results = [];
const t0 = performance.now();
const stamp = () => ((performance.now() - t0) / 1000).toFixed(1) + 's';
function log(...parts) {
  const line = `[${stamp()}] ${parts.join(' ')}`;
  out.textContent += line + '\n';
  console.log(line);
}
function record(name, ok, detail, seconds) {
  results.push({ name, ok, detail, seconds });
  log(ok ? 'PASS' : 'FAIL', name, '-', detail, seconds != null ? `(${seconds.toFixed(2)}s)` : '');
}
async function timed(fn, limitMs = 60_000) {
  const start = performance.now();
  const value = await withDeadline(fn(), limitMs, `TIMEOUT after ${limitMs / 1000}s`);
  return [value, (performance.now() - start) / 1000];
}

const WRONG_CA = await (await fetch('./wrong-ca.pem')).text();
const byName = name => TRANSPORTS.find(t => t.name === name);
const SUITE_TRANSPORTS = {
  ws: [byName('snowflake-websocket')],
  webrtc: [byName('snowflake-webrtc')],
  chain: TRANSPORTS,
};

async function keepalive(socket, limitMs = 30_000) {
  const response = await request(socket, 'GET', '/v1/keepalive', { timeoutMs: limitMs });
  if (response.status !== 200) throw new Error(`keepalive status ${response.status}`);
}

async function runSuite(label, transports) {
  log(`===== ${label} =====`);
  let client;
  try {
    const events = [];
    const [connected, secs] = await timed(
      () =>
        connectTor({
          transports,
          rounds: 1,
          onEvent: e => {
            if (e.type === 'failed') {
              events.push(`${e.transport.name} failed after ${e.seconds.toFixed(1)}s (${e.reason})`);
              log(`transport ${e.transport.name} failed after ${e.seconds.toFixed(1)}s: ${e.reason}`);
            } else if (e.type === 'attempt') {
              log(`trying transport ${e.transport.name}`);
            }
          },
        }),
      15 * 60_000
    );
    client = connected.client;
    events.push(`connected via ${connected.transport.name}`);
    record(`${label}: Tor bootstrap`, true, events.join(', then '), secs);
  } catch (e) {
    record(`${label}: Tor bootstrap`, false, errorReason(e));
    return;
  }

  if (want('basic')) {
    // SECURITY: no connection unless the server proves it holds a certificate
    // issued by Signal's CA. Trusting a different root must fail.
    try {
      await timed(() => SignalSocket.open(client, CHAT_URL, WRONG_CA, null));
      record(`${label}: wrong CA is rejected`, false, 'UNEXPECTEDLY CONNECTED');
    } catch (e) {
      const msg = errorReason(e);
      record(`${label}: wrong CA is rejected`, /UnknownIssuer|invalid peer certificate|certificate/i.test(msg), msg);
    }

    // Connect (pinned to Signal's CA) and do a request/response round trip, 3 times.
    for (let i = 1; i <= 3; i++) {
      try {
        const [socket, openSecs] = await timed(() => openSignalSocket(client, CHAT_URL));
        const [, rttSecs] = await timed(() => keepalive(socket));
        await socket.close();
        record(`${label}: chat socket #${i}`, true, `connect ${openSecs.toFixed(2)}s, request round trip ${rttSecs.toFixed(2)}s`, openSecs + rttSecs);
      } catch (e) {
        record(`${label}: chat socket #${i}`, false, errorReason(e));
      }
    }

    // The Authorization header really reaches Signal: bogus credentials are refused.
    try {
      const bogus = 'Basic ' + btoa('00000000-0000-4000-8000-000000000000.1:not-a-real-password');
      const [status, secs] = await timed(() =>
        openSignalSocket(client, CHAT_URL, { authorization: bogus }).then(
          async socket => {
            await socket.close();
            return 101;
          },
          e => {
            if (e.status) return e.status;
            throw e;
          }
        )
      );
      record(`${label}: Authorization header is evaluated`, status === 401 || status === 403, `server answered HTTP ${status === 101 ? '101 (accepted!)' : status}`, secs);
    } catch (e) {
      record(`${label}: Authorization header is evaluated`, false, errorReason(e));
    }

    // Server-initiated messages work: the provisioning socket (device linking)
    // pushes an address unprompted. We ack it and close; nothing is linked.
    try {
      const [{ socket, address, verb, path }, secs] = await timed(() => receiveProvisioningAddress(client));
      await socket.close();
      record(`${label}: server push (provisioning address)`, address.length > 0, `${verb} ${path}, address of ${address.length} chars`, secs);
    } catch (e) {
      record(`${label}: server push (provisioning address)`, false, errorReason(e));
    }
  }

  // ROBUSTNESS: push megabytes through one Snowflake session. Flow-control bugs
  // in the session layers (SMUX window updates) stall after ~256 KB.
  if (want('bulk')) {
    try {
      let total = 0;
      const [, secs] = await timed(async () => {
        for (let i = 0; i < 3; i++) {
          const res = await client.fetch('https://speed.cloudflare.com/__down?bytes=900000');
          total += res.body.length;
        }
      }, 180_000);
      record(`${label}: bulk transfer`, total >= 2_700_000, `${(total / 1e6).toFixed(2)} MB in ${secs.toFixed(1)}s = ${(total / 1e3 / secs).toFixed(0)} KB/s`, secs);
    } catch (e) {
      record(`${label}: bulk transfer`, false, errorReason(e));
    }
  }

  // ROBUSTNESS: hold one connection open with periodic keepalives, then force a
  // brand-new circuit and reconnect.
  if (want('hold')) {
    try {
      const socket = await openSignalSocket(client, CHAT_URL);
      const rtts = [];
      const end = performance.now() + HOLD_MINUTES * 60_000;
      while (performance.now() < end) {
        const [, rtt] = await timed(() => keepalive(socket), 30_000);
        rtts.push(rtt);
        log(`keepalive ok, round trip ${rtt.toFixed(2)}s`);
        await new Promise(r => setTimeout(r, KEEPALIVE_SECS * 1000));
      }
      await socket.close();
      rtts.sort((a, b) => a - b);
      record(`${label}: hold connection ${HOLD_MINUTES} min`, true,
        `${rtts.length} keepalives, round trip min ${rtts[0].toFixed(2)}s / median ${rtts[rtts.length >> 1].toFixed(2)}s / max ${rtts[rtts.length - 1].toFixed(2)}s`);
    } catch (e) {
      record(`${label}: hold connection ${HOLD_MINUTES} min`, false, errorReason(e));
    }

    try {
      const [, secs] = await timed(async () => {
        await client.updateCircuit(60_000);
        const socket = await openSignalSocket(client, CHAT_URL);
        await keepalive(socket);
        await socket.close();
      }, 120_000);
      record(`${label}: reconnect after new circuit`, true, 'new circuit + connect + round trip', secs);
    } catch (e) {
      record(`${label}: reconnect after new circuit`, false, errorReason(e));
    }
  }

  try { await client.close(); } catch {}
}

async function run() {
  document.getElementById('run').disabled = true;
  onTransportLog((level, target, message) => {
    if (/WARN|ERROR/i.test(level) || /clos|dead|reset|shutdown|EOF|disconnect|keepalive timeout|reactor/i.test(message)) {
      log('[webtor]', level, target, message.slice(0, 250));
    }
  });
  log('page origin:', location.origin, '| secure context:', isSecureContext, '| suites:', SUITES.join(','), '| checks:', ONLY.join(','));
  try {
    for (const suite of SUITES) {
      const transports = SUITE_TRANSPORTS[suite];
      if (!transports) {
        record(`suite ${suite}`, false, 'unknown suite');
        continue;
      }
      await runSuite(suite === 'chain' ? 'fallback-chain' : transports[0].name, transports);
    }
  } catch (e) {
    record('suite', false, String(e?.stack ?? e));
  }
  window.__done = results;
  log('DONE');
}

document.getElementById('run').addEventListener('click', run);
document.getElementById('plan').textContent = `Suites: ${SUITES.join(', ')}. Checks: ${ONLY.join(', ')}.`;
if (params.has('autorun')) run();
