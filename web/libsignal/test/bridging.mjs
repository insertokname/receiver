// SPDX-License-Identifier: AGPL-3.0-only
//
// Loads libsignal's BridgingTest unchanged, except for the suites that need
// a TokioAsyncContext (libsignal-net's async runtime, not in the web build):
// those are registered as pending without running their bodies.

const NEEDS_TOKIO = new Set(['NativeTestingNice', 'TestStream']);

const realDescribe = globalThis.describe;
globalThis.describe = (title, fn) =>
  NEEDS_TOKIO.has(title)
    ? realDescribe.skip(`${title} (needs TokioAsyncContext)`, () => {})
    : realDescribe(title, fn);
try {
  await import('../dist/package/dist/test/BridgingTest.js');
} finally {
  globalThis.describe = realDescribe;
}
