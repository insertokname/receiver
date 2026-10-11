// SPDX-License-Identifier: AGPL-3.0-only
//
// The carrier every Signal connection of the app runs on: the app's Tor
// client. This module is the one place that choice is made. The end-to-end
// test build (renderer/build.mjs --e2e, never deployed) replaces it at build
// time with web/e2e/relay-carrier.ts; production builds contain no other
// carrier and have no runtime switch.

export { getTorCarrier as getCarrier, startTor as startCarrier } from './tor.ts';
