// SPDX-License-Identifier: AGPL-3.0-only
//
// Chat connections to Signal's chat server: libsignal-net's chat layer
// (rust/net/src/chat*, rust/net/chat) over the carrier.
//
// Each connection is a WebSocket of WebSocketMessage protobufs (requests and
// responses matched by id). The server pushes requests (messages, queue
// empty, the provisioning address and envelope) that the listener acks.
// Keepalive and dead-connection detection follow libsignal-net: a ping after
// 31 s without outgoing or incoming frames, disconnect after 45 s without
// anything from the server. Every failure ends in onConnectionInterrupted
// with the error libsignal would report, so Desktop's reconnect logic runs.

import type { Net } from '@signalapp/libsignal-client';
import type {
  ChatRequest,
  ChatServerMessageAck,
  ChatServiceListener,
  ConnectionEventsListener,
  ConnectionInfo,
  ProvisioningConnectionListener,
  RequestOptions,
} from '@signalapp/libsignal-client/dist/net.js';

import { SignalService as Proto } from '../../ts/protobuf/index.std.ts';
import { createLogger } from '../../ts/logging/log.std.ts';
import { signalservice } from './generated/SubProtocol.mjs';
import {
  cancelled,
  chatServiceInactive,
  ErrorCode,
  ioError,
  libsignalError,
  LibSignalErrorBase,
  rateLimited,
  requestTimedOut,
  retryAfterSeconds,
} from './errors.ts';
import type { Carrier } from './tor.ts';
import { UpgradeRefusedError } from './tor.ts';
import type { HeaderPairs, SignalConnection } from '../transport/dist/index.js';

const log = createLogger('chat');

const { WebSocketMessage } = signalservice;

type ChatResponse = Awaited<ReturnType<Net.UnauthenticatedChatConnection['fetch']>>;

// rust/net/src/env.rs, rust/net/infra/src/timeouts.rs
export const TIMESTAMP_HEADER = 'x-signal-timestamp';
const ALERT_HEADER = 'x-signal-alert';
const CONNECTION_INVALIDATED_CLOSE_CODE = 4401;
const CONNECTED_ELSEWHERE_CLOSE_CODE = 4409;
const KEEPALIVE_INTERVAL_MS = 31_000;
const MAX_IDLE_MS = 45_000;
const CHECK_INTERVAL_MS = 1_000;
// node/ts/net/Chat.ts
const DEFAULT_CHAT_REQUEST_TIMEOUT_MILLIS = 5000;
// One connection attempt: Tor stream + TLS + WebSocket handshake.
const CONNECT_ATTEMPT_TIMEOUT_MS = 30_000;
const CONNECT_ATTEMPTS = 2;

const REASON_PHRASES: Record<number, string> = {
  200: 'OK',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export type ServerRequest = Readonly<{
  verb: string;
  path: string;
  headers: ReadonlyArray<string>;
  body: Uint8Array<ArrayBuffer> | null;
  id: bigint;
}>;

type Pending = {
  resolve: (response: ChatResponse) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** Headers of a ChatResponse: names lowercased, values trimmed (http::HeaderMap). */
function parseHeaders(lines: ReadonlyArray<string>): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error('invalid header in response');
    result.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  return result;
}

function headerValue(headers: ReadonlyArray<[string, string]>, name: string): string | undefined {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1];
}

/**
 * The protocol engine of one chat connection: request/response bookkeeping,
 * server requests, liveness. Owns the SignalConnection.
 */
export class ChatSocket {
  readonly #connection: SignalConnection;
  readonly #carrier: Carrier;
  readonly #session: number;
  readonly #logTag: string;
  readonly #onRequest: (request: ServerRequest) => void;
  readonly #onClosed: (cause: LibSignalErrorBase | null) => void;
  readonly #pending = new Map<bigint, Pending>();
  #nextId = 0n;
  #lastSent = Date.now();
  #lastReceived = Date.now();
  #lastPing = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #unsubscribeLost: () => void = () => undefined;

  constructor({
    connection,
    carrier,
    session,
    logTag,
    onRequest,
    onClosed,
  }: {
    connection: SignalConnection;
    carrier: Carrier;
    session: number;
    logTag: string;
    onRequest: (request: ServerRequest) => void;
    onClosed: (cause: LibSignalErrorBase | null) => void;
  }) {
    this.#connection = connection;
    this.#carrier = carrier;
    this.#session = session;
    this.#logTag = logTag;
    this.#onRequest = onRequest;
    this.#onClosed = onClosed;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /** Starts reading and the liveness checks; events flow from here on. */
  start(): void {
    if (this.#closed || this.#timer !== undefined) return;
    this.#unsubscribeLost = this.#carrier.onLost(session => {
      if (session === this.#session) {
        this.#finish(ioError('websocket error: transport lost (Tor client replaced)', this.#logTag), true);
      }
    });
    this.#timer = setInterval(() => this.#check(), CHECK_INTERVAL_MS);
    void this.#readLoop();
  }

  async #readLoop(): Promise<void> {
    while (!this.#closed) {
      let frame;
      try {
        frame = await this.#connection.next();
      } catch (error) {
        this.#finish(ioError(`websocket error: ${String((error as Error)?.message ?? error)}`, this.#logTag), true);
        return;
      }
      if (this.#closed) return;
      this.#lastReceived = Date.now();
      if (frame === true) continue;
      if (!(frame instanceof Uint8Array)) {
        this.#finish(this.#closeError(frame.code), false);
        return;
      }
      try {
        this.#handleFrame(frame as Uint8Array<ArrayBuffer>);
      } catch (error) {
        // ChatProtocolError: the server sent something we cannot parse.
        log.error(`${this.#logTag}: invalid frame from server: ${String((error as Error)?.message ?? error)}`);
        this.#finish(ioError('websocket error: received invalid data', this.#logTag), false);
        return;
      }
    }
  }

  #closeError(code: number): LibSignalErrorBase {
    if (code === CONNECTED_ELSEWHERE_CLOSE_CODE) {
      return libsignalError(
        'ConnectedElsewhere',
        'the server explicitly disconnected us because we connected elsewhere with the same credentials',
        this.#logTag
      );
    }
    if (code === CONNECTION_INVALIDATED_CLOSE_CODE) {
      return libsignalError(
        'ConnectionInvalidated',
        'the server explicitly disconnected us for some reason other than that we connected elsewhere',
        this.#logTag
      );
    }
    return ioError(`websocket error: channel already closed (close code ${code})`, this.#logTag);
  }

  #handleFrame(bytes: Uint8Array<ArrayBuffer>): void {
    const message = WebSocketMessage.decode(bytes);
    if (message.type === WebSocketMessage.Type.RESPONSE && message.response && !message.request) {
      const { response } = message;
      const id = response.id ?? 0n;
      const pending = this.#pending.get(id);
      if (!pending) {
        log.warn(`${this.#logTag}: response for unknown request`);
        return;
      }
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      const status = response.status ?? 0;
      if (status < 100 || status > 999) {
        pending.reject(ioError('failed to decode data received from the server', this.#logTag));
        return;
      }
      let headers;
      try {
        headers = parseHeaders(response.headers);
      } catch {
        pending.reject(ioError('failed to decode data received from the server', this.#logTag));
        return;
      }
      pending.resolve({
        status,
        message: response.message ?? undefined,
        headers,
        body: response.body ?? undefined,
      });
      return;
    }
    if (message.type === WebSocketMessage.Type.REQUEST && message.request && !message.response) {
      const { request } = message;
      this.#onRequest({
        verb: request.verb ?? '',
        path: request.path ?? '',
        headers: request.headers,
        body: request.body,
        id: request.id ?? 0n,
      });
      return;
    }
    throw new Error(`unexpected message type ${message.type}`);
  }

  #check(): void {
    if (this.#closed) return;
    const now = Date.now();
    if (now - this.#lastReceived >= MAX_IDLE_MS) {
      log.warn(`${this.#logTag}: nothing from the server for ${Math.round((now - this.#lastReceived) / 1000)}s`);
      this.#carrier.reportStall(this.#session);
      this.#finish(ioError('websocket error: channel was idle for too long', this.#logTag), true);
      return;
    }
    const localIdle = now - this.#lastSent >= KEEPALIVE_INTERVAL_MS;
    const remoteIdle =
      now - this.#lastReceived >= KEEPALIVE_INTERVAL_MS && now - this.#lastPing >= KEEPALIVE_INTERVAL_MS;
    if (localIdle || remoteIdle) this.ping();
  }

  ping(): void {
    if (this.#closed) return;
    this.#lastPing = Date.now();
    this.#lastSent = this.#lastPing;
    this.#connection.ping().catch(error => this.#sendFailed(error));
  }

  #send(bytes: Uint8Array): void {
    this.#lastSent = Date.now();
    this.#connection.send(bytes).catch(error => this.#sendFailed(error));
  }

  #sendFailed(error: unknown): void {
    if (this.#closed) return;
    log.warn(`${this.#logTag}: send failed: ${String((error as Error)?.message ?? error)}`);
    this.#finish(ioError('websocket error: send failed', this.#logTag), true);
  }

  /**
   * Sends a request; resolves to the response. `timeoutMs` undefined means
   * no timeout (libsignal's typed APIs).
   */
  fetch(
    request: ChatRequest,
    timeoutMs: number | undefined,
    operation: string,
    abortSignal?: AbortSignal
  ): Promise<ChatResponse> {
    if (this.#closed) return Promise.reject(chatServiceInactive(operation));
    if (abortSignal?.aborted) return Promise.reject(cancelled(operation));
    const id = this.#nextId++;
    let bytes: Uint8Array;
    try {
      bytes = WebSocketMessage.encode({
        type: WebSocketMessage.Type.REQUEST,
        request: {
          verb: request.verb,
          path: request.path,
          body: request.body ?? null,
          headers: request.headers.map(([name, value]) => {
            // RequestHasInvalidHeader: header names and values must be ASCII.
            // eslint-disable-next-line no-control-regex
            if (!/^[\x21-\x7e]+$/.test(name) || !/^[\x20-\x7e\t]*$/.test(value)) {
              throw libsignalError(
                'IoError',
                'request object must contain only ASCII text as header names and values.',
                operation
              );
            }
            return `${name}: ${value}`;
          }),
          id,
        },
        response: null,
      });
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<ChatResponse>((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      const remove = () => {
        this.#pending.delete(id);
        clearTimeout(pending.timer);
      };
      if (timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          remove();
          reject(requestTimedOut(operation));
        }, timeoutMs);
      }
      if (abortSignal) {
        abortSignal.addEventListener(
          'abort',
          () => {
            if (this.#pending.get(id) !== pending) return;
            remove();
            reject(cancelled(operation));
          },
          { once: true }
        );
      }
      this.#pending.set(id, pending);
      this.#send(bytes);
    });
  }

  /** Responds to a server request (an ack). */
  respond(id: bigint, status: number, operation: string): void {
    if (!Number.isInteger(status) || status < 100 || status > 999) {
      throw new TypeError(`invalid HTTP status ${status}`);
    }
    if (this.#closed) throw chatServiceInactive(operation);
    this.#send(
      WebSocketMessage.encode({
        type: WebSocketMessage.Type.RESPONSE,
        request: null,
        response: {
          id,
          status,
          message: REASON_PHRASES[status] ?? '',
          headers: [],
          body: null,
        },
      })
    );
  }

  /** A liveness check: a keepalive request that must answer within `timeoutMs`. */
  async probe(timeoutMs: number): Promise<void> {
    if (this.#closed) return;
    this.ping();
    try {
      await this.fetch({ verb: 'GET', path: '/v1/keepalive', headers: [] }, timeoutMs, 'keepalive');
    } catch (error) {
      if (this.#closed) return;
      log.warn(`${this.#logTag}: liveness check failed`);
      this.#carrier.reportStall(this.#session);
      this.#finish(ioError('websocket error: connection is not responding', this.#logTag), true);
    }
  }

  async disconnect(): Promise<void> {
    if (this.#closed) return;
    this.#finish(null, false);
    await this.#connection.close(1000, 'Normal Closure').catch(() => undefined);
  }

  /** Ends the connection; `cause` null means we disconnected deliberately. */
  #finish(cause: LibSignalErrorBase | null, closeSocket: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#unsubscribeLost();
    // In-flight requests fail with ChatServiceInactive, unless the server
    // said why it closed the connection.
    const pendingError =
      cause && (cause.code === ErrorCode.ConnectedElsewhere || cause.code === ErrorCode.ConnectionInvalidated)
        ? cause
        : null;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(pendingError ?? chatServiceInactive(this.#logTag));
    }
    this.#pending.clear();
    if (closeSocket) void this.#connection.close(1000, '').catch(() => undefined);
    if (cause) log.warn(`${this.#logTag}: connection interrupted: ${cause.message}`);
    else log.info(`${this.#logTag}: disconnected`);
    queueMicrotask(() => this.#onClosed(cause));
  }
}

export class WebConnectionInfo implements ConnectionInfo {
  readonly localPort = 0;
  readonly ipVersion = 'IPv4' as const;
  constructor(readonly description: string) {}
  toString(): string {
    return this.description;
  }
}

/** Builds a libsignal ConnectError from a failed connection attempt. */
function connectError(error: unknown, operation: string): LibSignalErrorBase {
  if (error instanceof LibSignalErrorBase) return error;
  if (error instanceof UpgradeRefusedError) {
    const { status, headers } = error;
    // Without the confirmation header the answer may not be from Signal at
    // all (libsignal then treats the route as failed).
    if (headerValue(headers, TIMESTAMP_HEADER) === undefined) {
      return ioError('all connect attempts failed', operation);
    }
    const retryAfter = retryAfterSeconds(headers);
    if (retryAfter !== undefined) return rateLimited(retryAfter, operation);
    if (status === 499) return libsignalError('AppExpired', 'app version is too old', operation);
    if (status === 403) return libsignalError('DeviceDelinked', 'device was deregistered', operation);
    return ioError(`websocket error: HTTP error: ${status}`, operation);
  }
  if ((error as { name?: string })?.name === 'AbortError') return cancelled(operation);
  return ioError(`websocket error: ${String((error as Error)?.message ?? error)}`, operation);
}

export type ConnectedSocket = Readonly<{
  connection: SignalConnection;
  session: number;
  info: WebConnectionInfo;
  headers: HeaderPairs;
}>;

/** Opens a chat WebSocket, with libsignal's error semantics. */
export async function connectChatSocket({
  carrier,
  url,
  headers,
  operation,
  abortSignal,
}: {
  carrier: Carrier;
  url: string;
  headers: HeaderPairs;
  operation: string;
  abortSignal?: AbortSignal;
}): Promise<ConnectedSocket> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    if (abortSignal?.aborted) throw cancelled(operation);
    try {
      const opened = await carrier.openSocket(url, {
        headers,
        timeoutMs: CONNECT_ATTEMPT_TIMEOUT_MS,
        signal: abortSignal,
      });
      return {
        connection: opened.connection,
        session: opened.session,
        info: new WebConnectionInfo(opened.description),
        headers: opened.connection.headers,
      };
    } catch (error) {
      if (abortSignal?.aborted) throw cancelled(operation);
      // The server answered: no point in another attempt.
      if (error instanceof UpgradeRefusedError) throw connectError(error, operation);
      lastError = error;
      log.warn(`${operation}: attempt ${attempt} failed: ${String((error as Error)?.message ?? error)}`);
    }
  }
  throw connectError(lastError, operation);
}

/** Acks for server requests, like libsignal's ChatServerMessageAck. */
export function makeAck(socket: ChatSocket, id: bigint, operation: string): ChatServerMessageAck {
  let sent = false;
  return {
    send(statusCode: number): void {
      if (sent) throw new Error('a message is only acked once');
      sent = true;
      socket.respond(id, statusCode, operation);
    },
  } as ChatServerMessageAck;
}

/** Server timestamp and alerts from the upgrade response (ws.rs report_alerts). */
export function connectResponseEvents(headers: HeaderPairs): {
  timestamp: number | undefined;
  alerts: Array<string>;
} {
  const raw = headerValue(headers, TIMESTAMP_HEADER);
  let timestamp: number | undefined;
  if (raw !== undefined) {
    if (/^\d+$/.test(raw)) timestamp = Number(raw);
    else log.warn(`unexpected ${TIMESTAMP_HEADER} (not a positive integer)`);
  }
  const alerts = headers
    .filter(([name]) => name.toLowerCase() === ALERT_HEADER)
    .flatMap(([, value]) => value.split(',').map(alert => alert.trim()).filter(alert => alert.length > 0));
  return { timestamp, alerts };
}

/** Dispatch of server requests on an authenticated chat connection (server_requests.rs). */
export function chatRequestHandler(
  getSocket: () => ChatSocket,
  listener: ChatServiceListener | ConnectionEventsListener,
  logTag: string
): (request: ServerRequest) => void {
  return request => {
    if (request.verb !== 'PUT') {
      log.error(`${logTag}: server request used unexpected verb ${request.verb}`);
      return;
    }
    if (!('onQueueEmpty' in listener)) {
      log.error(`${logTag}: server request on an unauthenticated connection`);
      return;
    }
    switch (request.path) {
      case '/api/v1/queue/empty':
        log.info(`${logTag}: received queue empty notification`);
        listener.onQueueEmpty();
        return;
      case '/api/v1/message': {
        let timestamp = 0;
        for (const header of request.headers) {
          const colon = header.indexOf(':');
          if (colon > 0 && header.slice(0, colon).trim().toLowerCase() === TIMESTAMP_HEADER) {
            const value = header.slice(colon + 1).trim();
            if (/^\d+$/.test(value)) timestamp = Number(value);
          }
        }
        if (!timestamp) log.warn(`${logTag}: server delivered message with no valid ${TIMESTAMP_HEADER} header`);
        listener.onIncomingMessage(
          request.body ?? new Uint8Array(0),
          timestamp,
          makeAck(getSocket(), request.id, 'ServerMessageAck_SendStatus')
        );
        return;
      }
      case '':
        log.error(`${logTag}: server request missing path`);
        return;
      default:
        log.error(`${logTag}: server sent an unknown request`);
    }
  };
}

/** Dispatch of server requests on the provisioning connection. */
export function provisioningRequestHandler(
  getSocket: () => ChatSocket,
  listener: ProvisioningConnectionListener,
  logTag: string
): (request: ServerRequest) => void {
  return request => {
    if (request.verb !== 'PUT') {
      log.error(`${logTag}: server request used unexpected verb ${request.verb}`);
      return;
    }
    switch (request.path) {
      case '/v1/address': {
        let address: string;
        try {
          address = Proto.ProvisioningAddress.decode(request.body ?? new Uint8Array(0)).address ?? '';
        } catch {
          log.error(`${logTag}: could not parse server request body`);
          return;
        }
        listener.onReceivedAddress(address, makeAck(getSocket(), request.id, 'ServerMessageAck_SendStatus'));
        return;
      }
      case '/v1/message':
        listener.onReceivedEnvelope(
          request.body ?? new Uint8Array(0),
          makeAck(getSocket(), request.id, 'ServerMessageAck_SendStatus')
        );
        return;
      case '':
        log.error(`${logTag}: server request missing path`);
        return;
      default:
        log.error(`${logTag}: server sent an unknown request`);
    }
  };
}

export { DEFAULT_CHAT_REQUEST_TIMEOUT_MILLIS };
export type { ChatResponse, RequestOptions };
