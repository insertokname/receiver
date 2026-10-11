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
// connection on the old one is told it was lost.
//
// Carrier is the seam for tests: a test build can hand WebNet a different
// implementation (e.g. TLS over a WebSocket to a local relay in front of
// Desktop's mock server) without touching the chat or HTTP layers.

import {
  connectTor,
  errorReason,
  onTransportLog,
  openSignalSocket,
  SIGNAL_CA_PEM,
  SignalHttps,
} from '../transport/dist/index.js';
import type {
  HeaderPairs,
  SignalConnection,
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
  body?: Uint8Array;
  rootPem: string;
  timeoutMs: number;
  maxResponseBytes: number;
}>;

export type HttpsResponse = Readonly<{
  status: number;
  headers: HeaderPairs;
  body: Uint8Array;
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
  state: 'starting' | 'bootstrapping' | 'ready' | 'retrying';
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

// After this many consecutive failures, ask Tor for a new circuit; after
// REPLACE_AFTER, rebuild the client.
const NEW_CIRCUIT_AFTER = 2;
const REPLACE_AFTER = 4;
const NEW_CIRCUIT_DEADLINE_MS = 30_000;

type Session = {
  id: number;
  client: TorClient;
  transport: Transport;
  https: SignalHttps;
};

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
    const onEvent = (event: TorEvent) => {
      switch (event.type) {
        case 'attempt':
          log.info(`connecting via ${event.transport.name} (round ${event.round})`);
          this.#setStatus({ state: 'bootstrapping', transport: event.transport.label });
          break;
        case 'failed':
          log.warn(`${event.transport.name} failed after ${event.seconds.toFixed(1)}s: ${event.reason}`);
          break;
        case 'connected':
          log.info(`circuit ready via ${event.transport.name} in ${event.seconds.toFixed(1)}s`);
          break;
        case 'backoff':
          log.warn(`every transport failed, retrying in ${Math.round(event.delayMs / 1000)}s`);
          this.#setStatus({ state: 'retrying', detail: `retrying in ${Math.round(event.delayMs / 1000)}s` });
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
    if (this.#session?.id === session) this.#failed(this.#session, 'connection stalled');
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

  async openSocket(url: string, { rootPem, headers, timeoutMs, signal }: OpenSocketOptions): Promise<OpenedSocket> {
    const session = await this.#current(signal);
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
      } else {
        this.#failed(session, errorReason(error));
      }
      throw error;
    }
  }

  async request(request: HttpsRequest, signal?: AbortSignal): Promise<HttpsResponse> {
    const session = await this.#current(signal);
    try {
      const response = (await waitFor(
        session.https.request(
          request.method,
          request.url,
          request.headers,
          request.body,
          request.rootPem,
          request.timeoutMs,
          request.maxResponseBytes
        ) as Promise<HttpsResponse>,
        signal
      )) as HttpsResponse;
      this.#succeeded();
      if (response.status === 429) this.#newCircuit(session, 'rate limited');
      return response;
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
