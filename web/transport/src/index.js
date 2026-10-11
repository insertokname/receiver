// SPDX-License-Identifier: AGPL-3.0-only
//
// Reaching Signal through Tor from a static page.
//
// connectTor() bootstraps a Tor client (webtor-rs, WASM) over a chain of
// Snowflake transports, first to last, and retries the whole chain with
// backoff until one works. Every failed attempt is reported with its reason.
// openSignalSocket() opens a WebSocket to a Signal host through that client;
// its TLS (rustls, TLS 1.3) trusts only Signal's CA.

import initWasm, {
  init as initWebtorLogging,
  setLogCallback,
  SignalSocket,
  TorClient,
  TorClientOptions,
} from './pkg/webtor_wasm.js';
import SIGNAL_CA_PEM from './signal-ca.js';

export { SIGNAL_CA_PEM, SignalSocket };

// Budgets are per attempt and cover bridge connection + Tor handshake + first
// circuit. WebSocket bridges answer in 1-3 s when they work.
// WebRTC: webtor tries up to 3 volunteer proxies, each with a fresh broker
// request (a few seconds, retried by webtor when no proxy is free), ICE
// gathering (up to 10 s) and DataChannel open (up to 30 s). About 3 x 45 s
// when every proxy fails, so 180 s lets all of its retries run.
export const TRANSPORTS = Object.freeze([
  Object.freeze({
    name: 'snowflake-websocket',
    label: 'Snowflake bridge (WebSocket)',
    bridgeUrl: 'wss://snowflake.torproject.net/',
    budgetMs: 30_000,
  }),
  Object.freeze({
    name: 'snowflake-webrtc',
    label: 'Snowflake volunteer proxy (WebRTC)',
    webrtc: true,
    budgetMs: 180_000,
  }),
]);

const BACKOFF_INITIAL_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
// Our own deadline fires this long after webtor's, in case the WASM side hangs.
const DEADLINE_GRACE_MS = 10_000;

const logListeners = new Set();

/** Receives webtor's log lines: (level, target, message). */
export function onTransportLog(listener) {
  logListeners.add(listener);
  return () => logListeners.delete(listener);
}

let loading;
export function loadTransport() {
  loading ??= (async () => {
    await initWasm();
    initWebtorLogging();
    setLogCallback((level, target, message) => {
      for (const listener of logListeners) listener(String(level), String(target), String(message));
    });
  })();
  return loading;
}

export function errorReason(error) {
  if (typeof error === 'string') return error;
  return String(error?.message ?? error);
}

/** Rejects with `message` if `promise` is not settled within `ms`. */
export function withDeadline(promise, ms, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message ?? `timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exponential backoff with jitter: round 1 -> ~2 s, doubling, capped at 60 s. */
export function backoffDelay(round) {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** (round - 1));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function clientOptions(transport, directoryUrl) {
  const options = transport.webrtc
    ? TorClientOptions.snowflakeWebRtc()
    : new TorClientOptions(transport.bridgeUrl);
  return options
    .withConnectionTimeout(transport.budgetMs)
    .withCircuitTimeout(transport.budgetMs)
    .withDirectoryUrl(directoryUrl);
}

async function attempt(transport, directoryUrl) {
  const creating = TorClient.create(clientOptions(transport, directoryUrl));
  let client;
  try {
    client = await withDeadline(
      creating,
      transport.budgetMs + DEADLINE_GRACE_MS,
      `no Tor circuit after ${(transport.budgetMs + DEADLINE_GRACE_MS) / 1000}s`
    );
  } catch (error) {
    // If webtor finishes after our deadline, don't leave its connection open.
    creating.then(late => late.close(), () => {});
    throw error;
  }
  try {
    await withDeadline(client.waitForCircuit(), transport.budgetMs, 'circuit not ready');
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

/**
 * Bootstraps Tor over the first transport in `transports` that works.
 *
 * Tries each transport in order; after a full round of failures waits
 * (exponential backoff) and starts over, up to `rounds` rounds (default: no
 * limit). `onEvent` receives {type: 'attempt' | 'failed' | 'connected' |
 * 'backoff', ...} for every step. Resolves to {client, transport}; rejects
 * when `signal` aborts or the rounds are used up.
 */
export async function connectTor({
  transports = TRANSPORTS,
  directoryUrl = new URL('./tor', import.meta.url).href,
  rounds = Infinity,
  onEvent = () => {},
  signal,
} = {}) {
  await loadTransport();
  const failures = [];
  for (let round = 1; round <= rounds; round++) {
    for (const transport of transports) {
      signal?.throwIfAborted();
      onEvent({ type: 'attempt', transport, round });
      const started = performance.now();
      try {
        const client = await attempt(transport, directoryUrl);
        if (signal?.aborted) {
          await client.close().catch(() => {});
          signal.throwIfAborted();
        }
        onEvent({ type: 'connected', transport, round, seconds: (performance.now() - started) / 1000 });
        return { client, transport };
      } catch (error) {
        const reason = errorReason(error);
        failures.push(`${transport.name}: ${reason}`);
        onEvent({ type: 'failed', transport, round, reason, seconds: (performance.now() - started) / 1000 });
      }
    }
    if (round < rounds) {
      const delayMs = backoffDelay(round);
      onEvent({ type: 'backoff', round, delayMs });
      await sleep(delayMs, signal);
    }
  }
  throw new Error(`could not reach Tor: ${failures.join('; ')}`);
}

/**
 * Opens a WebSocket to `url` (wss://<Signal host>/...) through `client`.
 * TLS trusts only Signal's CA. Throws (with `status`) if the server refuses
 * the upgrade.
 */
export async function openSignalSocket(client, url, { authorization = null } = {}) {
  const socket = await SignalSocket.open(client, url, SIGNAL_CA_PEM, authorization);
  if (typeof socket === 'number') {
    throw Object.assign(new Error(`${new URL(url).host} refused the WebSocket: HTTP ${socket}`), {
      status: socket,
    });
  }
  return socket;
}
