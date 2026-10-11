// SPDX-License-Identifier: AGPL-3.0-only
//
// The web build's stand-in for libsignal's `Net` (libsignal-net, which is
// not compiled into the WebAssembly build). Desktop reaches it through
// getLibsignalNet() (ts/textsecure/preconnect.web.ts).
//
// This is the boundary the network layer implements over the Tor transport
// (web/transport): every method Desktop calls is listed here. Until then,
// configuration calls are accepted and every connection or request rejects
// with NetNotAvailableError, which Desktop's callers log and retry.

import type { Net } from '@signalapp/libsignal-client';

export class NetNotAvailableError extends Error {
  override name = 'NetNotAvailableError';
}

function notYet(method: string): never {
  throw new NetNotAvailableError(
    `libsignal Net.${method} is not available in the web build yet (network over Tor)`
  );
}

export type WebNetOptions = Readonly<{
  env: 'production' | 'staging';
  userAgent: string;
}>;

export class WebNet {
  readonly options: WebNetOptions;

  #remoteConfig: ReadonlyMap<string, string> = new Map();

  constructor(options: WebNetOptions) {
    this.options = options;
  }

  // Configuration (accepted; the Tor transport has its own policy).

  setIpv6Enabled(_enabled: boolean): void {}

  setProxyFromUrl(_url: string): void {
    throw new NetNotAvailableError('proxies are not supported: the web build connects through Tor');
  }

  clearProxy(): void {}

  setRemoteConfig(remoteConfig: ReadonlyMap<string, string>, _buildVariant: unknown): void {
    this.#remoteConfig = remoteConfig;
  }

  getRemoteConfig(): ReadonlyMap<string, string> {
    return this.#remoteConfig;
  }

  onNetworkChange(): void {}

  // Connections and requests.

  async preconnectChat(): Promise<void> {
    notYet('preconnectChat');
  }

  async connectUnauthenticatedChat(..._args: Array<unknown>): Promise<Net.UnauthenticatedChatConnection> {
    notYet('connectUnauthenticatedChat');
  }

  async connectAuthenticatedChat(..._args: Array<unknown>): Promise<Net.AuthenticatedChatConnection> {
    notYet('connectAuthenticatedChat');
  }

  async connectProvisioning(..._args: Array<unknown>): Promise<Net.ProvisioningConnection> {
    notYet('connectProvisioning');
  }

  async cdsiLookup(..._args: Array<unknown>): Promise<never> {
    notYet('cdsiLookup');
  }

  async createRegistrationSession(..._args: Array<unknown>): Promise<never> {
    notYet('createRegistrationSession');
  }

  async resumeRegistrationSession(..._args: Array<unknown>): Promise<never> {
    notYet('resumeRegistrationSession');
  }

  svr2(..._args: Array<unknown>): never {
    notYet('svr2');
  }
}
