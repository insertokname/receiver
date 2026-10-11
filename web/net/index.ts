// SPDX-License-Identifier: AGPL-3.0-only
//
// The web build's libsignal `Net` (libsignal-net is not compiled into the
// WebAssembly build): the methods Desktop calls, with the types and
// semantics of libsignal's node/ts/net.ts, over the Tor carrier (tor.ts).
// Desktop reaches it through getLibsignalNet() (ts/textsecure/preconnect.web.ts).
//
// Available: chat connections (unauthenticated, authenticated), the
// provisioning connection (device linking), the typed chat calls Desktop
// uses. Not available yet, each rejecting with a typed libsignal error:
// contact discovery (CDSI, needs SGX attestation), SVR2, registration, key
// transparency, backups.

import { Buffer } from 'node:buffer';

import { Aci } from '@signalapp/libsignal-client';

import { ConnectTimeoutError } from '../../ts/textsecure/Errors.std.ts';
import type {
  ChatServiceListener,
  ConnectionEventsListener,
  ProvisioningConnectionListener,
} from '@signalapp/libsignal-client/dist/net.js';
import type { LibSignalError, Net } from '@signalapp/libsignal-client';

import { createLogger } from '../../ts/logging/log.std.ts';
import type { HeaderPairs } from '../transport/dist/index.js';
import {
  ChatSocket,
  chatRequestHandler,
  connectChatSocket,
  connectResponseEvents,
  provisioningRequestHandler,
} from './chat.ts';
import {
  WebAuthenticatedChatConnection,
  WebProvisioningConnection,
  WebUnauthenticatedChatConnection,
} from './connections.ts';
import { notAvailable } from './errors.ts';
import { getCarrier } from './carrier.ts';
import type { Carrier } from './tor.ts';
import { SIGNAL_CA_PEM } from './tor.ts';

const log = createLogger('webnet');

// rust/bridge/shared/types/src/net.rs NETWORK_CHANGE_DEBOUNCE
const NETWORK_CHANGE_DEBOUNCE_MS = 1000;
const LIVENESS_CHECK_TIMEOUT_MS = 10_000;

export type WebNetOptions = Readonly<{
  env: 'production' | 'staging';
  userAgent: string;
  /** Where connections are carried; the app's carrier (Tor) by default. */
  carrier?: Carrier;
  /** The chat server's host[:port]; Signal's for `env` by default. */
  chatHost?: string;
  /** The only root the chat server's TLS certificate may chain to; Signal's CA by default. */
  rootPem?: string;
}>;

type Languages = { languages?: Array<string>; abortSignal?: AbortSignal };

export class WebNet {
  readonly options: WebNetOptions;
  readonly #carrier: Carrier;
  readonly #chatHost: string;
  readonly #rootPem: string;
  readonly #sockets = new Set<ChatSocket>();
  #remoteConfig: ReadonlyMap<string, string> = new Map();
  #networkChangeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: WebNetOptions) {
    this.options = options;
    this.#carrier = options.carrier ?? getCarrier();
    this.#chatHost =
      options.chatHost ?? (options.env === 'staging' ? 'chat.staging.signal.org' : 'chat.signal.org');
    this.#rootPem = options.rootPem ?? SIGNAL_CA_PEM;
  }

  // Configuration.

  setIpv6Enabled(_enabled: boolean): void {
    // The exit relay chooses the address family.
  }

  setProxyFromUrl(_url: string): void {
    throw new TypeError('proxies are not supported: the web build connects through Tor');
  }

  clearProxy(): void {}

  setRemoteConfig(remoteConfig: ReadonlyMap<string, string>, _buildVariant: unknown): void {
    this.#remoteConfig = remoteConfig;
  }

  getRemoteConfig(): ReadonlyMap<string, string> {
    return this.#remoteConfig;
  }

  /**
   * After a network change, check that each open connection still answers
   * (libsignal sends an internal keepalive); dead ones are interrupted, so
   * Desktop reconnects right away instead of waiting for the idle timeout.
   */
  onNetworkChange(): void {
    clearTimeout(this.#networkChangeTimer);
    this.#networkChangeTimer = setTimeout(() => {
      log.info(`network changed: checking ${this.#sockets.size} connections`);
      this.#carrier.onNetworkChange();
      for (const socket of this.#sockets) void socket.probe(LIVENESS_CHECK_TIMEOUT_MS);
    }, NETWORK_CHANGE_DEBOUNCE_MS);
  }

  // Connections.

  async preconnectChat(): Promise<void> {
    await this.#carrier.ready();
  }

  #url(path: string): string {
    return `wss://${this.#chatHost}${path}`;
  }

  #headers(extra: HeaderPairs): HeaderPairs {
    return [...extra, ['User-Agent', this.options.userAgent]];
  }

  #track(socket: ChatSocket): void {
    this.#sockets.add(socket);
  }

  #untrack(socket: ChatSocket | undefined): void {
    if (socket) this.#sockets.delete(socket);
  }

  async connectUnauthenticatedChat(
    listener: ConnectionEventsListener,
    options?: Languages
  ): Promise<Net.UnauthenticatedChatConnection> {
    const operation = 'UnauthenticatedChatConnection_connect';
    const languages = languageHeader(options?.languages);
    const connected = await connectChatSocket({
      carrier: this.#carrier,
      rootPem: this.#rootPem,
      url: this.#url('/v1/websocket/'),
      headers: this.#headers(languages),
      operation,
      abortSignal: options?.abortSignal,
    });
    const logTag = 'unauthenticated';
    let socket: ChatSocket | undefined;
    socket = new ChatSocket({
      connection: connected.connection,
      carrier: this.#carrier,
      session: connected.session,
      logTag,
      onRequest: chatRequestHandler(() => socket as ChatSocket, listener, logTag),
      onClosed: cause => {
        this.#untrack(socket);
        listener.onConnectionInterrupted(cause as LibSignalError | null);
      },
    });
    const { alerts } = connectResponseEvents(connected.headers);
    if (alerts.length) log.warn(`${alerts.length} unexpected alerts on an unauthenticated connection`);
    this.#track(socket);
    setTimeout(() => socket?.start(), 0);
    return new WebUnauthenticatedChatConnection(socket, connected.info) as unknown as Net.UnauthenticatedChatConnection;
  }

  async connectAuthenticatedChat(
    username: string,
    password: string,
    receiveStories: boolean,
    listener: ChatServiceListener,
    options?: Languages
  ): Promise<Net.AuthenticatedChatConnection> {
    const operation = 'AuthenticatedChatConnection_connect';
    const { aci, deviceId } = parseUsername(username);
    const basic = Buffer.from(`${aci.getServiceIdString()}.${deviceId}:${password}`).toString('base64');
    const headers: HeaderPairs = [
      ['Authorization', `Basic ${basic}`],
      ['x-signal-receive-stories', receiveStories ? 'true' : 'false'],
      ...languageHeader(options?.languages),
    ];
    const connected = await connectChatSocket({
      carrier: this.#carrier,
      rootPem: this.#rootPem,
      url: this.#url('/v1/websocket/'),
      headers: this.#headers(headers),
      operation,
      abortSignal: options?.abortSignal,
    });
    const logTag = 'authenticated';
    let socket: ChatSocket | undefined;
    socket = new ChatSocket({
      connection: connected.connection,
      carrier: this.#carrier,
      session: connected.session,
      logTag,
      onRequest: chatRequestHandler(() => socket as ChatSocket, listener, logTag),
      onClosed: cause => {
        this.#untrack(socket);
        listener.onConnectionInterrupted(cause as LibSignalError | null);
      },
    });
    this.#track(socket);
    const { timestamp, alerts } = connectResponseEvents(connected.headers);
    setTimeout(() => {
      // As libsignal does once the listener is attached: the server's clock,
      // then the alerts (an empty list clears earlier ones).
      if (timestamp !== undefined) listener.onServerTimestamp?.(timestamp);
      listener.onReceivedAlerts?.(alerts);
      socket?.start();
    }, 0);
    return new WebAuthenticatedChatConnection(socket, connected.info, aci) as unknown as Net.AuthenticatedChatConnection;
  }

  async connectProvisioning(
    listener: ProvisioningConnectionListener,
    options?: { abortSignal?: AbortSignal }
  ): Promise<Net.ProvisioningConnection> {
    const operation = 'ProvisioningChatConnection_connect';
    let connected: Awaited<ReturnType<typeof connectChatSocket>>;
    try {
      connected = await connectChatSocket({
        carrier: this.#carrier,
        rootPem: this.#rootPem,
        url: this.#url('/v1/websocket/provisioning/'),
        headers: this.#headers([]),
        operation,
        abortSignal: options?.abortSignal,
      });
    } catch (error) {
      // SocketManager aborts the provisioning connection when its timeout
      // runs out. Reported as Desktop's connect timeout, so that the
      // Provisioner retries with its longer timeouts (10, 20, 30, 60 s):
      // over Tor a first connection can take longer than 10 s.
      if (options?.abortSignal?.aborted) {
        throw new ConnectTimeoutError();
      }
      throw error;
    }
    const logTag = 'provisioning';
    let socket: ChatSocket | undefined;
    socket = new ChatSocket({
      connection: connected.connection,
      carrier: this.#carrier,
      session: connected.session,
      logTag,
      onRequest: provisioningRequestHandler(() => socket as ChatSocket, listener, logTag),
      onClosed: cause => {
        this.#untrack(socket);
        listener.onConnectionInterrupted(cause as LibSignalError | null);
      },
    });
    this.#track(socket);
    setTimeout(() => socket?.start(), 0);
    return new WebProvisioningConnection(socket, connected.info) as unknown as Net.ProvisioningConnection;
  }

  // Not available yet.

  async cdsiLookup(..._args: Array<unknown>): Promise<never> {
    throw notAvailable('contact discovery (CDSI)', 'CdsiLookup');
  }

  async createRegistrationSession(..._args: Array<unknown>): Promise<never> {
    throw notAvailable('registration', 'RegistrationService_CreateSession');
  }

  async resumeRegistrationSession(..._args: Array<unknown>): Promise<never> {
    throw notAvailable('registration', 'RegistrationService_ResumeSession');
  }

  svr2(..._args: Array<unknown>): unknown {
    const fail = (operation: string) => () => Promise.reject(notAvailable('secure value recovery (SVR2)', operation));
    return {
      backup: fail('Svr2_Backup'),
      restore: fail('Svr2_Restore'),
      delete: fail('Svr2_Delete'),
      startBackup: fail('Svr2_StartBackup'),
      finishBackup: fail('Svr2_FinishBackup'),
      migrate: fail('Svr2_Migrate'),
    };
  }
}

function languageHeader(languages: ReadonlyArray<string> | undefined): HeaderPairs {
  return languages && languages.length > 0 ? [['Accept-Language', languages.join(',')]] : [];
}

/** AuthenticatedChatConnection::parse_username: "{aci}" or "{aci}.{deviceId}". */
function parseUsername(username: string): { aci: Aci; deviceId: number } {
  const dot = username.lastIndexOf('.');
  const aciPart = dot === -1 ? username : username.slice(0, dot);
  const devicePart = dot === -1 ? '1' : username.slice(dot + 1);
  const deviceId = /^\d+$/.test(devicePart) ? Number(devicePart) : NaN;
  let aci: Aci;
  try {
    aci = Aci.parseFromServiceIdString(aciPart);
  } catch {
    throw new TypeError('username must be of the form {ACI}.{deviceId}');
  }
  if (!Number.isInteger(deviceId) || deviceId < 1 || deviceId > 127) {
    throw new TypeError('username must be of the form {ACI}.{deviceId}');
  }
  return { aci, deviceId };
}
