// SPDX-License-Identifier: AGPL-3.0-only
//
// Desktop's local URLs (attachment://v2/<path>?key=...&size=...) in the web
// build. Electron serves them from its main process; in the browser they
// are same-origin URLs under the app, `<app>/attachment/<token>`, that the
// service worker hands to this page to answer (web/main/attachments.ts,
// web/sw/sw.ts).
//
// The original URL carries the attachment's local key, sometimes its
// transport key and plaintext hash, so it is never put in a URL as is: the
// token is the original URL sealed (AES-256-GCM, @noble/ciphers) under a key
// that exists only in this page's memory. If a request ever reached the
// network instead of the service worker (a page the worker does not
// control), the server would see only random bytes; and only the page that
// made a URL can open it. A reload makes new URLs; within a page the same
// local URL always gets the same web URL.

import { gcm } from '@noble/ciphers/aes.js';

const KEY = crypto.getRandomValues(new Uint8Array(32));
const NONCE_LENGTH = 12;
const DIRECTORY = 'attachment/';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

/** Where local URLs live: the app's `attachment/` directory. */
export function localUrlBase(): string {
  return new URL(DIRECTORY, document.baseURI).href;
}

// One web URL per local URL while the page lives: components ask again on
// every render, and a new URL makes an <img> load again (it flickers).
// Only once the service worker controls the page: before that (first visit,
// the worker still installing) a request fails, and a new URL on the next
// render is what loads it again.
const sealedUrls = new Map<string, string>();
const MAX_SEALED_URLS = 5000;

function isControlled(): boolean {
  return Boolean(navigator.serviceWorker?.controller);
}

/** The web URL for one of Desktop's local URLs (attachment://...). */
export function sealLocalUrl(url: string): string {
  const known = sealedUrls.get(url);
  if (known !== undefined) return known;

  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const sealed = gcm(KEY, nonce).encrypt(encoder.encode(url));
  const token = new Uint8Array(NONCE_LENGTH + sealed.length);
  token.set(nonce);
  token.set(sealed, NONCE_LENGTH);
  const webUrl = localUrlBase() + base64url(token);

  if (!isControlled()) return webUrl;
  if (sealedUrls.size >= MAX_SEALED_URLS) {
    const oldest = sealedUrls.keys().next().value;
    if (oldest !== undefined) sealedUrls.delete(oldest);
  }
  sealedUrls.set(url, webUrl);
  return webUrl;
}

/**
 * The service worker took this page over: images and media that failed
 * before (their requests went to the server) load again through it.
 */
export function reloadFailedMedia(): void {
  const base = localUrlBase();
  for (const element of document.querySelectorAll<HTMLImageElement | HTMLMediaElement>('img, video, audio')) {
    const failed =
      element instanceof HTMLImageElement ? !element.complete || element.naturalWidth === 0 : element.error !== null;
    if (!failed || !element.src.startsWith(base)) continue;
    const url = unsealLocalUrl(element.src);
    if (url === undefined) continue;
    element.src = sealLocalUrl(url);
    if (element instanceof HTMLMediaElement) element.load();
  }
}

/** Desktop's local URL behind a web URL made by sealLocalUrl() in this page, or undefined. */
export function unsealLocalUrl(href: string): string | undefined {
  const base = localUrlBase();
  if (!href.startsWith(base)) return undefined;
  const token = fromBase64url(href.slice(base.length).replace(/[?#].*$/, ''));
  if (!token || token.length <= NONCE_LENGTH) return undefined;
  try {
    return decoder.decode(gcm(KEY, token.subarray(0, NONCE_LENGTH)).decrypt(token.subarray(NONCE_LENGTH)));
  } catch {
    // Made by another page (or before a reload).
    return undefined;
  }
}

/**
 * After a failed answer (not a missing file): the next request for that
 * local URL gets a new web URL, so a component that renders again loads it
 * again (with one URL per local URL, a failed <img> would stay failed).
 */
export function renewLocalUrl(href: string): void {
  const url = unsealLocalUrl(href);
  if (url !== undefined && sealedUrls.get(url) === href.replace(/[?#].*$/, '')) {
    sealedUrls.delete(url);
  }
}

/** Whether `href` is a web local URL (made by any page of this app). */
export function isLocalUrl(href: string): boolean {
  return href.startsWith(localUrlBase());
}
