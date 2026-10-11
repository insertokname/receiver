// SPDX-License-Identifier: AGPL-3.0-only
//
// Replaces RingRTC's native addon (dist/ringrtc/Native.js). Calling is not
// available in the web build yet: RingRTC's TypeScript layer loads, and every
// native function throws when called.

import { NotAvailableInWebBuildError } from '../node/unavailable.ts';

const callEndpointPropertyKey = Symbol('callEndpoint (web build)');

const native = new Proxy(Object.create(null) as Record<PropertyKey, unknown>, {
  get(_target, property) {
    if (property === 'callEndpointPropertyKey') {
      return callEndpointPropertyKey;
    }
    if (typeof property === 'symbol' || property === 'then' || property === '__esModule') {
      return undefined;
    }
    return function ringrtcNotAvailable(): never {
      throw new NotAvailableInWebBuildError(
        `calling is not available in the web build (ringrtc ${property})`
      );
    };
  },
});

export default native;
