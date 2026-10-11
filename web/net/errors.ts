// SPDX-License-Identifier: AGPL-3.0-only
//
// libsignal's error objects, built the way its Node bridge builds them
// (rust/bridge/shared/types/src/node/error.rs): a LibSignalErrorBase with
// the error code's name, a message, the bridge operation's name and extra
// properties. Desktop checks `.code` (and `retryAfterSecs`, `entries`, ...).

import {
  ErrorCode,
  LibSignalErrorBase,
  MismatchedDevicesEntry,
} from '@signalapp/libsignal-client';
import type { ServiceId } from '@signalapp/libsignal-client';

export { ErrorCode, LibSignalErrorBase };

type CodeName = keyof typeof ErrorCode;

export function libsignalError(
  name: CodeName | undefined,
  message: string,
  operation: string,
  extraProps?: Record<string, unknown>
): LibSignalErrorBase {
  return new LibSignalErrorBase(message, name, operation, extraProps);
}

// libsignal-net's messages (displaydoc strings of the Rust enums).
export const ioError = (message: string, operation: string): LibSignalErrorBase =>
  libsignalError('IoError', message, operation);

/** SendError::Disconnected: the connection is closed. */
export const chatServiceInactive = (operation: string): LibSignalErrorBase =>
  libsignalError('ChatServiceInactive', 'connection is already closed', operation);

/** SendError::RequestTimedOut. */
export const requestTimedOut = (operation: string): LibSignalErrorBase =>
  libsignalError('IoError', 'timed out while sending a request', operation);

export const cancelled = (operation: string): LibSignalErrorBase =>
  libsignalError('Cancelled', 'operation was cancelled', operation);

/** RetryLater: "retry after {n}s". */
export const rateLimited = (retryAfterSecs: number, operation: string): LibSignalErrorBase =>
  libsignalError('RateLimitedError', `retry after ${retryAfterSecs}s`, operation, { retryAfterSecs });

export function mismatchedDevices(
  entries: ReadonlyArray<{
    account: ServiceId;
    missingDevices: Array<number>;
    extraDevices: Array<number>;
    staleDevices: Array<number>;
  }>,
  operation: string
): LibSignalErrorBase {
  return libsignalError('MismatchedDevices', 'mismatched devices', operation, {
    entries: entries.map(entry => new MismatchedDevicesEntry(entry)),
  });
}

/** For features the web build does not have yet: a typed, non-network error. */
export function notAvailable(
  feature: string,
  operation: string,
  name: CodeName | undefined = undefined
): LibSignalErrorBase {
  return libsignalError(name, `${feature} is not available in the web build yet`, operation);
}

/** Parses Retry-After (delta-seconds only, like libsignal's extract_retry_later). */
export function retryAfterSeconds(headers: ReadonlyArray<[string, string]>): number | undefined {
  const value = headers.find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
  if (value == null || !/^\s*\d+\s*$/.test(value)) return undefined;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

export function isAbort(signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted);
}
