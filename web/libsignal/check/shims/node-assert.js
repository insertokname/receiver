// SPDX-License-Identifier: AGPL-3.0-only
//
// node:assert as used by @signalapp/libsignal-client's net test helpers
// (FakeChat), which the package index pulls in.

export default function assert(value, message) {
  if (!value) throw new Error(message ?? 'assertion failed');
}

export function fail(message) {
  throw new Error(message ?? 'failed');
}
