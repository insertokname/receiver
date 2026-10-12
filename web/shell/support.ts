// SPDX-License-Identifier: AGPL-3.0-only
//
// What the browser must have for the app to run at all, checked before
// anything starts (WhatsApp Web shows a "browser not supported" page too):
// WebAssembly (libsignal, SQLite, Tor), the origin private file system with
// writable files on the page (the database and the app's files), Web Locks
// and BroadcastChannel (one window at a time), IndexedDB and Web Crypto
// (the database key).

import { showScreen } from './ui.ts';

export function missingFeatures(): Array<string> {
  const missing: Array<string> = [];
  if (typeof WebAssembly !== 'object') missing.push('WebAssembly');
  if (typeof navigator.storage?.getDirectory !== 'function') missing.push('file storage (origin private file system)');
  else if (typeof FileSystemFileHandle === 'undefined' || !('createWritable' in FileSystemFileHandle.prototype)) {
    missing.push('writable files (FileSystemWritableFileStream)');
  }
  if (typeof navigator.locks?.request !== 'function') missing.push('Web Locks');
  if (typeof BroadcastChannel !== 'function') missing.push('BroadcastChannel');
  if (typeof indexedDB === 'undefined') missing.push('IndexedDB');
  if (typeof crypto?.subtle?.importKey !== 'function') missing.push('Web Crypto');
  if (typeof Worker !== 'function') missing.push('Web Workers');
  return missing;
}

export function showUnsupportedBrowser(missing: ReadonlyArray<string>): void {
  showScreen({
    id: 'unsupported-browser',
    title: "This browser can't run receiver",
    text: [
      `It does not support: ${missing.join(', ')}.`,
      'Use a current version of Firefox, Chrome, Edge or Safari.',
    ],
  });
}
