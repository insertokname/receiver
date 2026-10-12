// SPDX-License-Identifier: AGPL-3.0-only

// How registration requests (linking this device, uploading its keys) are
// retried beyond WebAPI's own retries. Desktop: not at all. The web build's
// sibling (registrationRetry.web.ts) waits out reconnects.

export function withRegistrationRetry<T>(
  request: () => Promise<T>,
  _options?: { abortSignal?: AbortSignal }
): Promise<T> {
  return request();
}
