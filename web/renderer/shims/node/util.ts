// SPDX-License-Identifier: AGPL-3.0-only
// node:util on the `util` package, plus the newer helpers it lacks.

import util from 'util/util.js';

export const {
  callbackify,
  debuglog,
  deprecate,
  format,
  formatWithOptions,
  inherits,
  inspect,
  isDeepStrictEqual,
  promisify,
  types,
} = util as typeof util & {
  formatWithOptions: typeof util.format;
  isDeepStrictEqual: (a: unknown, b: unknown) => boolean;
};

// Terminal colours: plain text in the browser.
export function styleText(_format: string | Array<string>, text: string): string {
  return text;
}

export const { TextDecoder, TextEncoder } = globalThis;

export default { ...util, styleText, TextDecoder, TextEncoder };
