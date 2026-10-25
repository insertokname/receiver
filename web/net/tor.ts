// SPDX-License-Identifier: AGPL-3.0-only
//
// The app's one Tor client, and the carrier every Signal connection runs on.
//
// Bootstrapping starts when the app starts (startTor() in the entry point),
// so the client is usually ready by the time Desktop asks for the QR code.
// Each Signal connection is its own Tor stream plus TLS (pinned to Signal's
// CA, in the transport's Rust code). Failures are counted: after repeated
// failures, or when Signal rate-limits us, the client builds a new circuit
// (a new exit); if failures continue, the whole client is replaced
// (bootstrapped again over the transport chain, with backoff) and every
// connection on the old one is told it was lost. Some failures say which
// it is right away: a closed circuit or a stalled connection asks for a new
// circuit, a closed channel (the connection to the bridge) for a new client.
// The channel is also watched: webtor closes it when the bridge falls
// silent (no keepalive for 25 s), and the client is replaced at once. While
// a new circuit is being built, new connections wait for it (bounded by
// their timeout) instead of failing on the old one.
//
// Carrier is the seam for tests: a test build can hand WebNet a different
// implementation (e.g. TLS over a WebSocket to a local relay in front of
// Desktop's mock server) without touching the chat or HTTP layers.

import {
  connectTor,
  errorReason,
  fetchRanged,
  onTransportLog,
  openSignalSocket,
  SIGNAL_CA_PEM,
  SignalHttps,
  withDeadline,
} from '../transport/dist/index.js';
import type {
  HeaderPairs,
  SignalConnection,
  SignalHttpsBody,
  TorClient,
  TorEvent,
  Transport,
} from '../transport/dist/index.js';
import netAssets from 'virtual:web-net-assets';

import { createLogger } from '../../ts/logging/log.std.ts';

const log = createLogger('tor');

export { SIGNAL_CA_PEM };

export type HttpsRequest = Readonly<{
  method: string;
  url: string;
  headers: HeaderPairs;
  /**
   * The body in memory, or streamed: a function the transport calls for
   * each next piece (resolving to undefined at the end).
   */
  body?: Uint8Array | (() => Promise<Uint8Array | undefined>);
  rootPem: string;
  /**
   * Until the response head arrives (connecting and sending included); with
   * a streamed body, the longest wait for any step (a piece to be taken,
   * the response after the last one).
   */
  timeoutMs: number;
  /**
   * A large download (a GET from a CDN): fetched in byte ranges over up to
   * PARALLEL_LANES circuits in parallel, delivered in order (the transport's
   * fetchRanged); servers without ranges answer as usual.
   */
  parallel?: boolean;
  /** Longest wait for the next piece of the body (parallel downloads). */
  idleMs?: number;
}>;

/** A response body, received piece by piece (SignalHttpsBody). */
export type HttpsBodyReader = {
  /** The next piece, undefined at the end; rejects after `idleTimeoutMs` without data. */
  next(idleTimeoutMs: number): Promise<Uint8Array | undefined>;
  /** Stops receiving and drops the connection; a pending next() rejects. */
  cancel(): void;
};

export type HttpsResponse = Readonly<{
  status: number;
  headers: HeaderPairs;
  body: HttpsBodyReader;
  /** The carrier session it came over (for reportStall). */
  session: number;
}>;

/** The server answered a WebSocket upgrade with something other than 101. */
export class UpgradeRefusedError extends Error {
  override name = 'UpgradeRefusedError';
  constructor(
    readonly status: number,
    readonly headers: HeaderPairs
  ) {
    super(`WebSocket upgrade refused: HTTP ${status}`);
  }
}

export type OpenedSocket = Readonly<{
  connection: SignalConnection;
  /** Identifies the carrier session; see Carrier.onLost. */
  session: number;
  description: string;
}>;

export type CarrierStatus = Readonly<{
  /**
   * 'directory': the Tor directory (the list of relays) did not verify or
   * could not be fetched; 'clock': it is not valid at this device's time.
   */
  state: 'starting' | 'bootstrapping' | 'ready' | 'retrying' | 'directory' | 'clock';
  transport?: string;
  detail?: string;
}>;

export type OpenSocketOptions = Readonly<{
  rootPem: string;
  headers: HeaderPairs;
  timeoutMs: number;
  signal?: AbortSignal;
}>;

export interface Carrier {
  /** Resolves once the carrier can open connections. */
  ready(signal?: AbortSignal): Promise<void>;
  /** Opens a WebSocket whose TLS trusts only `rootPem`. */
  openSocket(url: string, options: OpenSocketOptions): Promise<OpenedSocket>;
  request(request: HttpsRequest, signal?: AbortSignal): Promise<HttpsResponse>;
  /** A connection on this carrier stalled or failed in transit. */
  reportStall(session: number): void;
  /** Called with a session id when every connection on it must be dropped. */
  onLost(listener: (session: number) => void): () => void;
  /** A quick check after the browser reports a network change. */
  onNetworkChange(): void;
}

// Circuit lanes: the chat connections (WebSockets) are alone on lane 0's
// circuit (the transport's default for sockets), HTTPS requests use lane 1,
// and parallel downloads lanes 1 to PARALLEL_LANES, each a circuit of its
// own, so a download never delays a message. At most 4: Snowflake is
// capacity donated for people in censored places.
const HTTPS_LANE = 1;
const PARALLEL_LANES = 4;

// After this many consecutive failures, ask Tor for a new circuit; after
// REPLACE_AFTER, rebuild the client.
const NEW_CIRCUIT_AFTER = 2;
const REPLACE_AFTER = 4;
const NEW_CIRCUIT_DEADLINE_MS = 30_000;
// A connection attempt its caller gave up on after this long (Desktop's
// link screen waits 10 s, then 20 s, ...) counts as a failure: a circuit
// that cannot open a connection in that time is not worth keeping.
const SLOW_OPEN_MS = 10_000;

// What a failure says about the Tor client (arti's error messages).
const CHANNEL_DEAD = /channel closed|channel .*(dead|failed|shut ?down)/i;
const CIRCUIT_DEAD = /circuit (closed|collapsed|destroyed)|circuit .*(dead|shut ?down)/i;

type Session = {
  id: number;
  client: TorClient;
  transport: Transport;
  https: SignalHttps;
};

/**
 * Wraps a transport response body; `onError` hears of failures (not of
 * cancel()). The WebAssembly object is freed once the body ended.
 */
export function bodyReader(body: SignalHttpsBody, onError: (error: unknown) => void = () => undefined): HttpsBodyReader {
  let done = false;
  let cancelled = false;
  const finish = () => {
    if (done) return;
    done = true;
    body.free();
  };
  return {
    async next(idleTimeoutMs) {
      if (cancelled) throw new Error('response body cancelled');
      if (done) return undefined;
      try {
        const piece = (await body.next(idleTimeoutMs)) as Uint8Array | undefined;
        if (piece === undefined) finish();
        return piece;
      } catch (error) {
        if (!cancelled) onError(error);
        finish();
        throw error;
      }
    },
    cancel() {
      if (cancelled || done) return;
      cancelled = true;
      body.cancel();
      // A pending next() still holds its own reference; it rejects now.
      finish();
    },
  };
}

type LaneSend = (headers: HeaderPairs, lane: number) => Promise<{ status: number; headers: HeaderPairs; body: HttpsBodyReader }>;

/**
 * Sends `request` with `send` (one request over a lane): a plain request on
 * the HTTPS lane, or a parallel download in byte ranges over several lanes
 * when it asks for one (see HttpsRequest.parallel); `renewLane` gives a lane
 * that is far slower than the others a new circuit.
 */
export function sendOnLanes(
  send: LaneSend,
  request: HttpsRequest,
  renewLane?: (lane: number) => Promise<void>
): Promise<{ status: number; headers: HeaderPairs; body: HttpsBodyReader }> {
  if (request.parallel && request.method === 'GET' && request.body === undefined) {
    return fetchRanged(send, {
      headers: request.headers,
      lanes: PARALLEL_LANES,
      firstLane: HTTPS_LANE,
      idleMs: request.idleMs,
      renewLane,
    });
  }
  return send(request.headers, HTTPS_LANE);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/**
 * The status for a Tor start that failed in a way the user should know
 * about: the device's clock is wrong (the bridge's certificates, or even the
 * bridge's fresh copy of the directory, are not valid at its time), or the
 * directory did not verify (webtor: "Tor directory: snapshot: ...; from the
 * bridge: ...").
 */
function directoryStatus(reason: string): CarrierStatus | undefined {
  if (/clock skew|from the bridge: [^;]*not valid at this time/.test(reason)) {
    return { state: 'clock', detail: reason };
  }
  if (reason.includes('Tor directory:')) return { state: 'directory', detail: reason };
  return undefined;
}

class TorCarrier implements Carrier {
  #session: Session | undefined;
  #waiting: Array<(session: Session) => void> = [];
  #bootstrapping = false;
  #nextId = 1;
  #failures = 0;
  #renewing: Promise<void> | undefined;
  readonly #lostListeners = new Set<(session: number) => void>();
  readonly #statusListeners = new Set<(status: CarrierStatus) => void>();
  #status: CarrierStatus = { state: 'starting' };

  get status(): CarrierStatus {
    return this.#status;
  }

  onStatus(listener: (status: CarrierStatus) => void): () => void {
    this.#statusListeners.add(listener);
    listener(this.#status);
    return () => this.#statusListeners.delete(listener);
  }

  #setStatus(status: CarrierStatus): void {
    this.#status = status;
    document.documentElement.dataset.tor = status.state;
    for (const listener of this.#statusListeners) listener(status);
  }

  start(): void {
    if (this.#session || this.#bootstrapping) return;
    this.#bootstrapping = true;
    void this.#bootstrap();
  }

  async #bootstrap(): Promise<void> {
    const started = performance.now();
    // A directory problem is reported as such until an attempt gets past it.
    let directoryProblem: CarrierStatus | undefined;
    const onEvent = (event: TorEvent) => {
      switch (event.type) {
        case 'attempt':
          log.info(`connecting via ${event.transport.name} (round ${event.round})`);
          this.#setStatus(directoryProblem ?? { state: 'bootstrapping', transport: event.transport.label });
          break;
        case 'failed':
          log.warn(`${event.transport.name} failed after ${event.seconds.toFixed(1)}s: ${event.reason}`);
          directoryProblem = directoryStatus(event.reason);
          if (directoryProblem) this.#setStatus(directoryProblem);
          break;
        case 'connected':
          log.info(`circuit ready via ${event.transport.name} in ${event.seconds.toFixed(1)}s`);
          break;
        case 'backoff':
          log.warn(`every transport failed, retrying in ${Math.round(event.delayMs / 1000)}s`);
          this.#setStatus(
            directoryProblem ?? { state: 'retrying', detail: `retrying in ${Math.round(event.delayMs / 1000)}s` }
          );
          break;
        default:
          break;
      }
    };
    // connectTor retries with backoff forever; it only throws if the
    // WebAssembly itself cannot load, so retry that too.
    for (let attempt = 1; ; attempt++) {
      try {
        const { client, transport } = await connectTor({
          wasm: netAssets.transport,
          directoryUrl: new URL(netAssets.torDirectory, location.href).href,
          onEvent,
        });
        const session: Session = {
          id: this.#nextId++,
          client,
          transport,
          https: new SignalHttps(client),
        };
        this.#session = session;
        this.#bootstrapping = false;
        this.#failures = 0;
        this.#watchChannel(session);
        log.info(`Tor ready after ${((performance.now() - started) / 1000).toFixed(1)}s`);
        this.#setStatus({ state: 'ready', transport: transport.label });
        const waiting = this.#waiting;
        this.#waiting = [];
        for (const resolve of waiting) resolve(session);
        return;
      } catch (error) {
        const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
        log.error(`could not start the Tor client: ${errorReason(error)}; retrying in ${delay / 1000}s`);
        this.#setStatus({ state: 'retrying', detail: errorReason(error) });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * The connection to the bridge closes when it fails, or when the bridge
   * has not been heard from for a while (webtor's SMUX keepalive: the bridge
   * sends something every 10 s, silence for 25 s closes it): then every
   * connection on it is dead, so the client is replaced at once instead of
   * waiting for each connection to notice.
   */
  #watchChannel(session: Session): void {
    session.client.waitForChannelClose().then(
      (reason: string) => {
        if (this.#session === session) this.#replace(session, `lost the bridge: ${reason}`);
      },
      (error: unknown) => log.warn(`cannot watch the connection to the bridge: ${errorReason(error)}`)
    );
  }

  #current(signal?: AbortSignal): Promise<Session> {
    this.start();
    if (this.#session) return Promise.resolve(this.#session);
    return waitFor(
      new Promise<Session>(resolve => this.#waiting.push(resolve)),
      signal
    );
  }

  async ready(signal?: AbortSignal): Promise<void> {
    await this.#current(signal);
  }

  #succeeded(): void {
    this.#failures = 0;
  }

  #failed(session: Session, reason: string): void {
    if (this.#session !== session) return;
    this.#failures += 1;
    log.warn(`connection failure ${this.#failures} on Tor session ${session.id}: ${reason}`);
    if (this.#failures >= REPLACE_AFTER) {
      this.#replace(session, `${this.#failures} consecutive failures`);
    } else if (CHANNEL_DEAD.test(reason)) {
      this.#replace(session, 'its channel closed');
    } else if (CIRCUIT_DEAD.test(reason)) {
      this.#newCircuit(session, 'circuit closed');
    } else if (this.#failures >= NEW_CIRCUIT_AFTER) {
      this.#newCircuit(session, 'repeated failures');
    }
  }

  #newCircuit(session: Session, why: string): void {
    if (this.#renewing || this.#session !== session) return;
    log.info(`building a new circuit (${why})`);
    this.#renewing = session.client
      .updateCircuit(NEW_CIRCUIT_DEADLINE_MS)
      .then(
        () => {
          log.info('new circuit ready');
          session.https.clear();
        },
        error => {
          log.warn(`new circuit failed: ${errorReason(error)}`);
          this.#replace(session, 'new circuit failed');
        }
      )
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        this.#renewing = undefined;
      });
  }

  #replace(session: Session, why: string): void {
    if (this.#session !== session) return;
    log.warn(`replacing the Tor client (${why})`);
    this.#session = undefined;
    this.#failures = 0;
    for (const listener of this.#lostListeners) {
      try {
        listener(session.id);
      } catch (error) {
        log.error(`lost listener failed: ${errorReason(error)}`);
      }
    }
    session.https.clear();
    void session.client.close().catch(() => undefined);
    this.start();
  }

  reportStall(session: number): void {
    if (this.#session?.id !== session) return;
    this.#failed(this.#session, 'connection stalled');
    // The bridge is still heard from (or the channel watch would have
    // replaced the client): the circuit is the suspect.
    if (this.#session?.id === session) this.#newCircuit(this.#session, 'a connection stalled');
  }

  onLost(listener: (session: number) => void): () => void {
    this.#lostListeners.add(listener);
    return () => this.#lostListeners.delete(listener);
  }

  onNetworkChange(): void {
    // Nothing to probe without traffic: the chat connections' own liveness
    // checks (WebNet.onNetworkChange) report stalls, which count here.
    if (!this.#session) this.start();
  }

  /**
   * A session to use: waits while the client bootstraps or builds a new
   * circuit, for at most `timeoutMs`.
   */
  async #usable(timeoutMs: number, signal?: AbortSignal): Promise<Session> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`Tor is not connected (waited ${Math.round(timeoutMs / 1000)}s)`);
      // eslint-disable-next-line no-await-in-loop
      const session = await withDeadline(this.#current(signal), left, `Tor is not connected (waited ${Math.round(timeoutMs / 1000)}s)`);
      const renewing = this.#renewing;
      if (!renewing || this.#session !== session) return session;
      // eslint-disable-next-line no-await-in-loop
      await withDeadline(waitFor(renewing, signal), Math.max(1, deadline - Date.now()), 'Tor is building a new circuit').catch(
        error => {
          if (signal?.aborted) throw error;
        }
      );
      if (Date.now() >= deadline) return this.#session ?? session;
    }
  }

  async openSocket(url: string, { rootPem, headers, timeoutMs, signal }: OpenSocketOptions): Promise<OpenedSocket> {
    const session = await this.#usable(timeoutMs, signal);
    const started = Date.now();
    const opening = openSignalSocket(session.client, url, { rootPem, headers, timeoutMs });
    try {
      const connection = await waitFor(opening, signal);
      this.#succeeded();
      return {
        connection,
        session: session.id,
        description: `Tor (${session.transport.name}) to ${new URL(url).host}`,
      };
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      if (typeof status === 'number') {
        // The server answered: the carrier works.
        this.#succeeded();
        if (status === 429) this.#newCircuit(session, 'rate limited');
        throw new UpgradeRefusedError(status, (error as { headers: HeaderPairs }).headers);
      }
      if (signal?.aborted) {
        // Do not leave a socket open that nobody will use.
        opening.then(
          connection => connection.close(1000, 'aborted'),
          () => undefined
        );
        if (Date.now() - started >= SLOW_OPEN_MS) this.#failed(session, 'connection attempt too slow');
      } else {
        this.#failed(session, errorReason(error));
      }
      throw error;
    }
  }

  async request(request: HttpsRequest, signal?: AbortSignal): Promise<HttpsResponse> {
    const session = await this.#usable(request.timeoutMs, signal);
    const send = async (headers: HeaderPairs, lane: number) => {
      const response = (await session.https.request(
        request.method,
        request.url,
        headers,
        request.body,
        request.rootPem,
        request.timeoutMs,
        lane
      )) as { status: number; headers: HeaderPairs; body: SignalHttpsBody };
      if (response.status === 429) this.#newCircuit(session, 'rate limited');
      return {
        status: response.status,
        headers: response.headers,
        body: bodyReader(response.body, error => this.#failed(session, errorReason(error))),
      };
    };
    try {
      const response = await waitFor(
        sendOnLanes(send, request, lane => session.https.renewLane(lane) as Promise<void>),
        signal
      );
      this.#succeeded();
      return {
        status: response.status,
        headers: response.headers,
        session: session.id,
        body: response.body,
      };
    } catch (error) {
      if (!signal?.aborted) this.#failed(session, errorReason(error));
      throw error;
    }
  }
}

let tor: TorCarrier | undefined;

function getTor(): TorCarrier {
  if (!tor) {
    tor = new TorCarrier();
    onTransportLog((level, target, message) => {
      if (/ERROR/i.test(level)) log.error(`webtor ${target}: ${message}`);
      else if (/WARN/i.test(level)) log.warn(`webtor ${target}: ${message}`);
    });
  }
  return tor;
}

/** Starts bootstrapping Tor (idempotent). */
export function startTor(): void {
  getTor().start();
}

export function onTorStatus(listener: (status: CarrierStatus) => void): () => void {
  return getTor().onStatus(listener);
}

/** The production carrier: the app's Tor client. */
export function getTorCarrier(): Carrier {
  return getTor();
}
