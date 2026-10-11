// SPDX-License-Identifier: AGPL-3.0-only

// Web build: the test and CI infrastructure (preload_test, CI.preload) is
// not part of the browser bundle.

const { config } = window.SignalContext;

if (config.environment === 'test' || config.ciMode) {
  throw new Error(
    `test/CI mode (${config.environment}, ${config.ciMode}) is not available in the web build`
  );
}

export {};
