// SPDX-License-Identifier: AGPL-3.0-only

// Web build: an honest User-Agent. This is not the official Signal Desktop
// client, so it must not present itself as one.
export function getUserAgent(appVersion: string, _release?: string): string {
  return `unofficial-web-client/${appVersion} (receiver)`;
}
