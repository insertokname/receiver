// SPDX-License-Identifier: AGPL-3.0-only
// node:assert/strict on the `assert` package.

import assert from 'assert';

const { strict } = assert;
export default strict;
export const {
  deepEqual,
  deepStrictEqual,
  equal,
  fail,
  notDeepEqual,
  notEqual,
  ok,
  rejects,
  strictEqual,
  throws,
} = strict;
