// SPDX-License-Identifier: AGPL-3.0-only

// Web build: a failed attachment download is retried a few times within
// seconds before Desktop's schedule (30 s, 5 min, 50 min, then hours). Over
// Tor a failure is usually one bad circuit, and the transport gives the
// next attempt another one (a stalled connection's circuit is replaced,
// a dead bridge connection replaces the Tor client within about 30 s), so
// a quick retry mostly works; waiting 30 s, then 5 minutes, leaves an image
// or a video missing for no reason. The rest is Desktop's: the same number
// of later attempts at the same intervals, and the same failure shown when
// they are used up.

import { SECOND } from '../util/durations/index.std.ts';
import type { ExponentialBackoffOptionsType } from '../util/exponentialBackoff.std.ts';

export type AttachmentDownloadRetryConfig = Readonly<{
  maxAttempts: number;
  backoffConfig: ExponentialBackoffOptionsType;
}>;

// Waits before the first retries; the last one is past the time a dead
// bridge connection takes to be noticed and replaced.
export const QUICK_RETRY_DELAYS = [3 * SECOND, 10 * SECOND, 20 * SECOND];

export function adaptRetryConfig(
  config: AttachmentDownloadRetryConfig
): AttachmentDownloadRetryConfig {
  // exponentialBackoffSleepTime(attempt) takes firstBackoffs in order, then
  // grows from the last of them: Desktop's attempt n is attempt n + 3 here.
  return {
    maxAttempts: config.maxAttempts + QUICK_RETRY_DELAYS.length,
    backoffConfig: {
      ...config.backoffConfig,
      firstBackoffs: [
        ...QUICK_RETRY_DELAYS,
        ...config.backoffConfig.firstBackoffs,
      ],
    },
  };
}
