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
//   only=basic,upload,bulk,hold,liveness,directory  which checks to run (default: basic)
//                           upload sends large request bodies to Signal,
//                           bulk downloads ~2.7 MB from a third party through
//                           Tor and hold keeps a connection open for minutes;
//                           they only run when asked for explicitly.
//                           directory runs the Tor directory verification on
//                           the site's snapshot and tampered copies of it (no
//                           network; needs the plain-text copies run.mjs serves
//                           at ./tor-plain/)
//                           liveness: an idle connection is kept, then the
//                           bridge connection is black-holed (no close, no
//                           error) by run.mjs's proxy (LIVENESS=1): it must be
//                           noticed within LIVENESS_BOUND_SECS and a new client
//                           must work; with `hidden` the page is hidden behind
//                           another tab first (run.mjs HIDDEN=1: the browser
//                           throttles its timers as for a user)
//   idleSecs=<n>            liveness: how long the connection stays idle (40)
//   rounds=<n>              bootstrap rounds over the transports (default 2:
//                           like the app, one retry after a failed attempt)
//   uploadKB=64,256,512,1024  request body sizes for the upload check
//   sustainedMB=<n>         upload check: also send n MB in back-to-back requests
//   maxBodyKB=256           upload check: largest single request body
//   hold=<minutes>  keepaliveSecs=<n>
//   autorun                 start without waiting for the button

import {
  connectTor,
  errorReason,
  loadTransport,
  onTransportLog,
  openSignalSocket,
  TRANSPORTS,
  sleep,
  verifyTorDirectory,
  withDeadline,
} from '../transport/index.js';
import { CHAT_URL, receiveProvisioningAddress, request } from '../lib/signal.js';

const params = new URLSearchParams(location.search);
const SUITES = (params.get('suites') ?? 'ws').split(',');
const ONLY = (params.get('only') ?? 'basic').split(',');
const HOLD_MINUTES = Number(params.get('hold') ?? 5);
const KEEPALIVE_SECS = Number(params.get('keepaliveSecs') ?? 30);
const UPLOAD_KB = (params.get('uploadKB') ?? '64,256,512,1024').split(',').map(Number);
const SUSTAINED_MB = Number(params.get('sustainedMB') ?? 0);
const IDLE_SECS = Number(params.get('idleSecs') ?? 40);
const ROUNDS = Number(params.get('rounds') ?? 2);
// webtor closes the channel after 25 s without anything from the bridge,
// checked every 5 s.
const LIVENESS_BOUND_SECS = 35;
const HIDDEN = params.has('hidden');
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

function randomBody(size) {
  const body = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) {
    crypto.getRandomValues(body.subarray(i, Math.min(size, i + 65536)));
  }
  return body;
}

// Sends `size` bytes as request bodies to an endpoint that needs credentials
// we don't have: Signal reads each whole WebSocket message before it answers
// (401), so a response proves the body crossed every transport layer. Bodies
// above Signal's message size limit go as several concurrent requests.
const MAX_REQUEST_BODY = Number(params.get('maxBodyKB') ?? 256) * 1024;
async function upload(socket, size, limitMs) {
  const parts = [];
  for (let left = size; left > 0; left -= MAX_REQUEST_BODY) parts.push(Math.min(left, MAX_REQUEST_BODY));
  const responses = await Promise.all(
    parts.map(n =>
      request(socket, 'PUT', '/v2/keys?identity=aci', {
        body: randomBody(n),
        headers: ['content-type:application/json'],
        timeoutMs: limitMs,
      })
    )
  );
  return [...new Set(responses.map(r => r.status))].join('/');
}

async function bootstrap(transports) {
  const events = [];
  const [connected, secs] = await timed(
    () =>
      connectTor({
        transports,
        rounds: ROUNDS,
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
  events.push(`connected via ${connected.transport.name}`);
  return { client: connected.client, detail: events.join(', then '), secs };
}

// The runner black-holes the bridge connection when asked (console line)
// and says so through window.__blackholed.
async function blackholeBridge() {
  console.log('ACTION blackhole');
  const asked = performance.now();
  while (!window.__blackholed) {
    if (performance.now() - asked > 10_000) throw new Error('no black hole: run with LIVENESS=1 (transport-test/run.mjs)');
    await sleep(50);
  }
  return performance.now();
}

// The runner opens another tab in front when asked (HIDDEN=1).
async function hide() {
  console.log('ACTION background');
  const asked = performance.now();
  while (document.visibilityState !== 'hidden') {
    if (performance.now() - asked > 10_000) throw new Error('the page was not hidden: run with HIDDEN=1 (transport-test/run.mjs)');
    await sleep(50);
  }
}

async function livenessCheck(label, client, transports) {
  if (HIDDEN) {
    await hide();
    log('page hidden');
  }
  const socket = await openSignalSocket(client, CHAT_URL);
  await keepalive(socket);
  let closed;
  const channelClosed = client.waitForChannelClose().then(reason => {
    closed = { at: performance.now(), reason };
    return closed;
  });
  log(`idle for ${IDLE_SECS}s`);
  await sleep(IDLE_SECS * 1000);
  if (closed) {
    record(`${label}: idle connection kept`, false, `closed while idle: ${closed.reason}`);
    return;
  }
  const [, rtt] = await timed(() => keepalive(socket));
  record(`${label}: idle connection kept`, true, `${IDLE_SECS}s without traffic, then a round trip in ${rtt.toFixed(2)}s`);

  const socketEnded = socket.recv().then(
    () => performance.now(),
    () => performance.now()
  );
  const start = await blackholeBridge();
  log('bridge connection black-holed');
  try {
    // Hidden, the page's own timers run late (this deadline's too): wait
    // longer, so that how late it was noticed is measured.
    const waitSecs = HIDDEN ? 4 * LIVENESS_BOUND_SECS : LIVENESS_BOUND_SECS;
    const { at, reason } = await withDeadline(channelClosed, waitSecs * 1000, `not noticed within ${waitSecs}s`);
    if ((at - start) / 1000 > LIVENESS_BOUND_SECS) {
      record(`${label}: black-holed bridge noticed`, false, `channel closed only after ${((at - start) / 1000).toFixed(1)}s (bound ${LIVENESS_BOUND_SECS}s)`, (at - start) / 1000);
      return;
    }
    const socketAt = await withDeadline(socketEnded, 5000, 'the open socket did not end with the channel');
    record(
      `${label}: black-holed bridge noticed`,
      true,
      `channel closed after ${((at - start) / 1000).toFixed(1)}s (${reason}), open socket ended after ${((socketAt - start) / 1000).toFixed(1)}s`,
      (at - start) / 1000
    );
  } catch (e) {
    record(`${label}: black-holed bridge noticed`, false, errorReason(e));
    return;
  }
  try {
    const { client: fresh, detail } = await bootstrap(transports);
    try {
      const next = await openSignalSocket(fresh, CHAT_URL);
      await keepalive(next);
      await next.close();
    } finally {
      await fresh.close().catch(() => {});
    }
    const secs = (performance.now() - start) / 1000;
    record(`${label}: new client after the black hole`, true, `${detail}; round trip on a new socket ${secs.toFixed(1)}s after the black hole`, secs);
  } catch (e) {
    record(`${label}: new client after the black hole`, false, errorReason(e));
  }
}

async function runSuite(label, transports) {
  log(`===== ${label} =====`);
  let client;
  try {
    const { client: connected, detail, secs } = await bootstrap(transports);
    client = connected;
    record(`${label}: Tor bootstrap`, true, detail, secs);
  } catch (e) {
    record(`${label}: Tor bootstrap`, false, errorReason(e));
    return;
  }

  if (want('basic')) {
    // SECURITY: no connection unless the server proves it holds a certificate
    // issued by Signal's CA. Trusting a different root must fail.
    try {
      await timed(() => openSignalSocket(client, CHAT_URL, { rootPem: WRONG_CA }));
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

  // ROBUSTNESS: large uploads (a linked device uploads ~230 KB of prekeys per
  // request). Write-side bugs in the session layers kill the Tor channel.
  if (want('upload')) {
    let socket;
    try {
      socket = await openSignalSocket(client, CHAT_URL);
      for (const kb of UPLOAD_KB) {
        const size = kb * 1024;
        log(`uploading ${kb} KB`);
        const [statuses, secs] = await timed(() => upload(socket, size, 120_000), 150_000);
        record(`${label}: upload ${kb} KB`, true, `HTTP ${statuses}, ${(size / 1024 / secs).toFixed(0)} KB/s`, secs);
      }
      if (SUSTAINED_MB > 0) {
        const size = SUSTAINED_MB * 1024 * 1024;
        let sent = 0;
        const [, secs] = await timed(async () => {
          while (sent < size) {
            const n = Math.min(MAX_REQUEST_BODY, size - sent);
            await upload(socket, n, 120_000);
            sent += n;
          }
        }, 30 * 60_000);
        record(`${label}: sustained upload ${SUSTAINED_MB} MB`, true, `${(size / 1024 / secs).toFixed(0)} KB/s`, secs);
      }
      const [, rtt] = await timed(() => keepalive(socket));
      record(`${label}: socket alive after uploads`, true, `round trip ${rtt.toFixed(2)}s`, rtt);
    } catch (e) {
      record(`${label}: upload`, false, errorReason(e));
    }
    try { await socket?.close(); } catch {}
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

  if (want('liveness')) {
    try {
      await livenessCheck(label, client, transports);
    } catch (e) {
      record(`${label}: liveness`, false, errorReason(e));
    }
  }

  try { await client.close(); } catch {}
}

// The client's directory verification (webtor directory.rs) on the site's
// snapshot, and on copies changed the ways an attacker serving the files
// could change them: each must be refused (or, for microdescriptors, the
// changed one dropped).
async function directoryChecks() {
  log('===== Tor directory verification =====');
  await loadTransport();
  const text = async name => {
    const response = await fetch(`./tor-plain/${name}`);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status} (run through transport-test/run.mjs)`);
    return response.text();
  };
  const [consensus, certs, microdescs, otherCerts] = await Promise.all(
    ['consensus.txt', 'certs.txt', 'microdescriptors.txt', 'other-network-certs.txt'].map(text)
  );
  const timeOf = keyword => Date.parse(`${consensus.match(new RegExp(`^${keyword} (.+)$`, 'm'))[1].replace(' ', 'T')}Z`);
  const fresh = timeOf('valid-after') + 30 * 60_000;
  const verify = (c, k, m, now = fresh) => verifyTorDirectory(c, k, m, now);
  const editFirst = (doc, prefix, edit) => doc.replace(new RegExp(`^${prefix}.*$`, 'm'), edit);
  const signatures = [...consensus.matchAll(/^directory-signature [\s\S]*?-----END SIGNATURE-----\n/gm)];
  const firstSignature = signatures[0].index;
  const corruptAll = signatures.reduce((doc, m) => {
    const at = m.index + m[0].indexOf('-----BEGIN SIGNATURE-----\n') + 36;
    return doc.slice(0, at) + (doc[at] === 'A' ? 'B' : 'A') + doc.slice(at + 1);
  }, consensus);
  const pinned = [...new Set([...certs.matchAll(/^fingerprint (\S+)$/gm)].map(m => m[1]))];
  const forgedCerts = certs.replace(/^fingerprint (\S+)$/gm, (_, fp) => `fingerprint ${pinned.find(other => other !== fp)}`);
  const microdescStarts = [...microdescs.matchAll(/^onion-key\n/gm)].map(m => m.index);

  const started = performance.now();
  const valid = verify(consensus, certs, microdescs);
  const seconds = (performance.now() - started) / 1000;
  record(
    'directory: snapshot verifies',
    valid.microdescriptors * 100 >= valid.relays * 95 && valid.droppedMicrodescriptors === 0,
    `${valid.relays} relays, ${valid.microdescriptors} microdescriptors, ${valid.certificates} certificates`,
    seconds
  );

  const refused = (name, expected, run) => {
    try {
      const summary = run();
      record(`directory: ${name}`, false, `accepted: ${JSON.stringify(summary)}`);
    } catch (e) {
      const reason = errorReason(e);
      record(`directory: ${name}`, expected.test(reason), `refused: ${reason}`);
    }
  };
  refused('a relay changed', /signatures do not verify/, () =>
    verify(editFirst(consensus, 'r ', line => line.replace(/ \d+\.\d+\.\d+\.\d+ /, ' 192.0.2.1 ')), certs, microdescs)
  );
  refused('every signature wrong', /signatures do not verify/, () => verify(corruptAll, certs, microdescs));
  refused('signatures missing (4 of 9 kept)', /not signed by enough/, () =>
    verify(consensus.slice(0, firstSignature) + signatures.slice(0, 4).map(m => m[0]).join(''), certs, microdescs)
  );
  refused('certificates of unknown authorities', /no valid certificate/, () => verify(consensus, otherCerts, microdescs));
  refused('certificates naming another authority', /no valid certificate/, () =>
    verify(consensus, forgedCerts, microdescs)
  );
  refused('expired beyond the tolerance', /not valid at this time/, () =>
    verify(consensus, certs, microdescs, timeOf('valid-until') + 3 * 86_400_000 + 60_000)
  );
  refused('too few microdescriptors', /too few microdescriptors/, () =>
    verify(consensus, certs, microdescs.slice(0, microdescStarts[Math.floor(microdescStarts.length / 10)]))
  );
  try {
    const late = verify(consensus, certs, microdescs, timeOf('valid-until') + 3 * 86_400_000 - 60_000);
    record('directory: accepted within the tolerance (3 days late)', late.relays === valid.relays, 'accepted');
  } catch (e) {
    record('directory: accepted within the tolerance (3 days late)', false, errorReason(e));
  }
  try {
    const tampered = verify(
      consensus,
      certs,
      editFirst(microdescs, 'ntor-onion-key ', () => `ntor-onion-key ${'A'.repeat(43)}`)
    );
    record(
      'directory: tampered microdescriptor dropped',
      tampered.droppedMicrodescriptors === 1 && tampered.usableRelays === valid.usableRelays - 1,
      `${tampered.droppedMicrodescriptors} dropped, ${tampered.usableRelays} usable`
    );
  } catch (e) {
    record('directory: tampered microdescriptor dropped', false, errorReason(e));
  }
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
    if (want('directory')) await directoryChecks();
    if (ONLY.every(check => check === 'directory')) SUITES.length = 0;
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
