// SPDX-License-Identifier: AGPL-3.0-only

// Web build: registration requests (linking this device, uploading its
// keys) wait out reconnects. WebAPI retries a request that failed for lack
// of a connection 3 times, 1 s apart; over Tor a reconnect can take longer
// (a stalled connection is noticed after up to 45 s, a new Tor client takes
// a few seconds), and a failed key upload fails the whole link while the
// phone already shows the new device. So such a failure is retried with
// backoff (2 s doubling to 30 s) for up to 3 minutes, then reported as
// before.

import { ErrorCode, LibSignalErrorBase } from '@signalapp/libsignal-client';

import { createLogger } from '../logging/log.std.ts';
import { HTTPError } from '../types/HTTPError.std.ts';
import { toLogFormat } from '../types/errors.std.ts';
import { MINUTE, SECOND } from '../util/durations/index.std.ts';
import { sleep } from '../util/sleep.std.ts';

const log = createLogger('registrationRetry');

const RETRY_FOR_MS = 3 * MINUTE;
const FIRST_DELAY_MS = 2 * SECOND;
const MAX_DELAY_MS = 30 * SECOND;

// The failures WebAPI's _retry treats as "no network".
function isNoNetwork(error: unknown): boolean {
  if (error instanceof HTTPError) return error.code === -1;
  return (
    error instanceof LibSignalErrorBase &&
    (error.code === ErrorCode.IoError ||
      error.code === ErrorCode.ChatServiceInactive)
  );
}

export async function withRegistrationRetry<T>(
  request: () => Promise<T>,
  options?: { abortSignal?: AbortSignal }
): Promise<T> {
  const giveUpAt = Date.now() + RETRY_FOR_MS;
  let delay = FIRST_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await request();
    } catch (error) {
      if (
        !isNoNetwork(error) ||
        options?.abortSignal?.aborted ||
        Date.now() + delay > giveUpAt
      ) {
        throw error;
      }
      log.warn(
        `attempt ${attempt} failed, retrying in ${delay / SECOND}s: ${toLogFormat(error)}`
      );
      // eslint-disable-next-line no-await-in-loop
      await sleep(delay, options?.abortSignal);
      delay = Math.min(MAX_DELAY_MS, delay * 2);
    }
  }
}
