// SPDX-License-Identifier: AGPL-3.0-only
// node:url: the WHATWG URL classes are the browser's; the legacy API comes
// from the `url` package.

import legacy from 'url/url.js';

const { URL, URLSearchParams } = globalThis;
export { URL, URLSearchParams };
export const { parse, format, resolve } = legacy;

export function fileURLToPath(url: string | URL): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'file:') {
    throw new TypeError('The URL must be of scheme file');
  }
  return decodeURIComponent(parsed.pathname);
}

export function pathToFileURL(path: string): URL {
  return new URL(`file://${encodeURI(path)}`);
}

export default {
  URL,
  URLSearchParams,
  parse,
  format,
  resolve,
  fileURLToPath,
  pathToFileURL,
};
