// SPDX-License-Identifier: AGPL-3.0-only
//
// End-to-end test builds only (renderer/build.mjs --e2e puts this module in
// place of web/net/carrier.ts; production builds never contain it): carries
// the app's TLS connections over WebSockets to the local test relay
// (web/e2e/relay.mjs), which forwards the bytes to Desktop's mock server.
// TLS still runs end to end in the transport's Rust code (rustls, TLS 1.3),
// trusting only the root the app passes: the mock server's CA, from the e2e
// build's config.

import netAssets from 'virtual:web-net-assets';
import e2eConfig from 'virtual:web-e2e-config';

import {
  errorReason,
  loadTransport,
  SignalConnection,
  SignalHttps,
  SignalSocket,
} from '../transport/dist/index.js';
import type { HeaderPairs } from '../transport/dist/index.js';
import { createLogger } from '../../ts/logging/log.std.ts';
import { UpgradeRefusedError } from '../net/tor.ts';
import type {
  Carrier,
  HttpsRequest,
  HttpsResponse,
  OpenedSocket,
  OpenSocketOptions,
} from '../net/tor.ts';

const log = createLogger('relay');

// The relay entry points exist only in the transport's test-relay build.
type RelayTransport = {
  openRelay(
    relayUrl: string,
    url: string,
    rootPem: string,
    headers: HeaderPairs,
    timeoutMs: number
  ): Promise<{ status: number; headers: HeaderPairs; socket?: unknown }>;
};
type RelayHttps = { relay(relayUrl: string): SignalHttps };

const SESSION = 1;

class RelayCarrier implements Carrier {
  #loading: Promise<void> | undefined;
  #https: SignalHttps | undefined;

  #load(): Promise<void> {
    this.#loading ??= loadTransport(netAssets.transport).then(
      () => {
        this.#https = (SignalHttps as unknown as RelayHttps).relay(e2eConfig.relayUrl);
        document.documentElement.dataset.tor = 'ready';
        log.info(`test relay carrier ready: ${e2eConfig.relayUrl}`);
      },
      error => {
        this.#loading = undefined;
        throw error;
      }
    );
    return this.#loading;
  }

  async ready(): Promise<void> {
    await this.#load();
  }

  async openSocket(url: string, { rootPem, headers, timeoutMs }: OpenSocketOptions): Promise<OpenedSocket> {
    await this.#load();
    const all: HeaderPairs = [...headers];
    const result = await (SignalSocket as unknown as RelayTransport).openRelay(
      e2eConfig.relayUrl,
      url,
      rootPem,
      all,
      timeoutMs
    );
    if (result.status !== 101) throw new UpgradeRefusedError(result.status, result.headers);
    const connection = new (SignalConnection as unknown as new (
      socket: unknown,
      headers: HeaderPairs
    ) => SignalConnection)(result.socket, result.headers);
    return { connection, session: SESSION, description: `test relay to ${new URL(url).host}` };
  }

  async request(request: HttpsRequest): Promise<HttpsResponse> {
    await this.#load();
    try {
      return (await (this.#https as SignalHttps).request(
        request.method,
        request.url,
        request.headers,
        request.body,
        request.rootPem,
        request.timeoutMs,
        request.maxResponseBytes
      )) as HttpsResponse;
    } catch (error) {
      log.warn(`request failed: ${errorReason(error)}`);
      throw error;
    }
  }

  reportStall(_session: number): void {}

  onLost(_listener: (session: number) => void): () => void {
    return () => undefined;
  }

  onNetworkChange(): void {}
}

const carrier = new RelayCarrier();

export function getCarrier(): Carrier {
  return carrier;
}

export function startCarrier(): void {
  void carrier.ready().catch(error => log.error(`test relay carrier failed: ${errorReason(error)}`));
}
