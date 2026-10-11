// SPDX-License-Identifier: AGPL-3.0-only

// Web build: there is no DNS resolver in the page; Signal's hosts are
// resolved by the Tor exit.

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

// The only caller is networkObserver's outage check (a DNS query for
// uptime.signal.org every few seconds while the chat socket is down). Without
// a resolver it has no answer, so the lookup never completes instead of
// logging an error on every attempt; connection problems still surface
// through the socket status.
function lookupNever(
  _hostname: string,
  _opts: unknown,
  _callback: (err: NodeJS.ErrnoException | null, addresses: string) => void
): void {
  // Intentionally never calls back.
}

export const electronLookup = lookupNever as unknown as typeof nodeLookup;
