// SPDX-License-Identifier: AGPL-3.0-only

// Web build: there is no DNS resolver in the page; Signal's hosts are
// resolved by the Tor exit. A lookup reports an error to its callback (the
// outage check in networkObserver logs it and carries on).

import type { LookupAddress, lookup as nodeLookup } from 'node:dns';

import type { DNSFallbackType } from '../types/DNSFallback.std.ts';

export function setFallback(_dnsFallback: DNSFallbackType): void {
  // The fallback addresses are only for direct connections.
}

export function setIPv6Enabled(_value: boolean): void {
  // Tor decides how to reach the destination.
}

export function interleaveAddresses(
  _addresses: ReadonlyArray<LookupAddress>
): Array<LookupAddress> {
  throw new Error('interleaveAddresses: not available in the web build');
}

function lookupAll(
  hostname: string,
  _opts: unknown,
  callback: (err: NodeJS.ErrnoException | null, addresses: string) => void
): void {
  const error: NodeJS.ErrnoException = new Error(
    `DNS lookup of ${hostname} is not available in the web build`
  );
  error.code = 'ENOTSUP';
  queueMicrotask(() => callback(error, ''));
}

export const electronLookup = lookupAll as unknown as typeof nodeLookup;
