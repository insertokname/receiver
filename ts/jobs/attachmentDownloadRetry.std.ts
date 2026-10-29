// SPDX-License-Identifier: AGPL-3.0-only

// How failed attachment downloads are retried. Desktop: its schedule as it
// is. The web build's sibling (attachmentDownloadRetry.web.ts) retries a few
// times quickly first.

import type { ExponentialBackoffOptionsType } from '../util/exponentialBackoff.std.ts';

export type AttachmentDownloadRetryConfig = Readonly<{
  maxAttempts: number;
  backoffConfig: ExponentialBackoffOptionsType;
}>;

export function adaptRetryConfig(
  config: AttachmentDownloadRetryConfig
): AttachmentDownloadRetryConfig {
  return config;
}
