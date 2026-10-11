// SPDX-License-Identifier: AGPL-3.0-only
//
// node:http in the web build: only the header validation node-fetch's
// Headers uses (same rules as Node's lib/_http_common.js). Requests go
// through web/net (Tor); every other export throws "not available".

const TOKEN = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
// eslint-disable-next-line no-control-regex
const INVALID_HEADER_CHAR = /[^\t\x20-\x7e\x80-\xff]/;

function codedError(Kind: typeof TypeError, code: string, message: string): Error {
  return Object.assign(new Kind(message), { code });
}

export function validateHeaderName(name: string): void {
  if (typeof name !== 'string' || !name || !TOKEN.test(name)) {
    throw codedError(TypeError, 'ERR_INVALID_HTTP_TOKEN', `Header name must be a valid HTTP token ["${name}"]`);
  }
}

export function validateHeaderValue(name: string, value: unknown): void {
  if (value === undefined) {
    throw codedError(TypeError, 'ERR_HTTP_INVALID_HEADER_VALUE', `Invalid value "${value}" for header "${name}"`);
  }
  if (INVALID_HEADER_CHAR.test(String(value))) {
    throw codedError(TypeError, 'ERR_INVALID_CHAR', `Invalid character in header content ["${name}"]`);
  }
}
