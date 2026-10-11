// SPDX-License-Identifier: AGPL-3.0-only

// Web build: the app reaches everything through Tor; a proxy setting does
// not apply.

export type { ProxyAgent } from './createProxyAgent.node.ts';

export async function createProxyAgent(_proxyUrl: string): Promise<never> {
  throw new Error('proxies are not supported: the web build connects through Tor');
}
