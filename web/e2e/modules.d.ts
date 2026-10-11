// SPDX-License-Identifier: AGPL-3.0-only
// Types for the end-to-end test build's own virtual module (renderer/build.mjs --e2e).

declare module 'virtual:web-e2e-config' {
  const config: {
    /** The test relay (web/e2e/relay.mjs), ws://127.0.0.1:<port>/. */
    relayUrl: string;
  };
  export default config;
}
