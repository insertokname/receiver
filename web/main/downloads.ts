// SPDX-License-Identifier: AGPL-3.0-only
//
// Saving files the WhatsApp Web way: a browser download (Desktop shows a
// save dialog and writes the file itself). Attachments are streamed from
// their local URL through the service worker, decrypted as the browser
// saves them (web/main/protocols.ts adds Content-Disposition); data that is
// already in memory is saved from a Blob.

const REVOKE_AFTER_MS = 60_000;
// The frame only starts the download; the browser carries on without it.
const FRAME_LIFETIME_MS = 10 * 60_000;

/**
 * Downloads a local URL (Content-Disposition: attachment) by loading it in a
 * hidden frame: a navigation, which the service worker answers, while
 * Chromium sends `<a download>` requests past service workers to the network.
 */
export function downloadLocalUrl(href: string): void {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.src = href;
  document.body.append(frame);
  setTimeout(() => frame.remove(), FRAME_LIFETIME_MS);
}

/** Starts the browser's download of `href` (a blob: URL) as `name`. */
export function downloadUrl(href: string, name: string): void {
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
}

/** Starts the browser's download of `data` as `name`. */
export function downloadBytes(data: Uint8Array, name: string, type = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type }));
  downloadUrl(url, name);
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

/** Whether downloads can stream through the service worker (it controls this page). */
export function canStreamDownloads(): boolean {
  return Boolean(navigator.serviceWorker?.controller);
}
