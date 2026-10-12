// SPDX-License-Identifier: AGPL-3.0-only
//
// Replaces RingRTC's native addon (dist/ringrtc/Native.js). Calling is not
// available in the web build yet: RingRTC's TypeScript layer loads, and every
// native function throws when called, except what Desktop does outside of
// calls: the settings it applies (our ACI once linked, microphone warm-up,
// sound assets), which have nothing to configure; the device lists, which
// are empty; and the peek at a group's call when its conversation opens,
// which finds no call.

import { NotAvailableInWebBuildError } from '../node/unavailable.ts';

const callEndpointPropertyKey = Symbol('callEndpoint (web build)');

const SETTINGS = new Set(['cm_setSelfUuid', 'cm_setMicrophoneWarmupEnabled', 'cm_addAsset']);
const ignore = (): void => undefined;
const noDevices = (): Array<never> => [];

type Observer = {
  handlePeekResponse(requestId: number, statusCode: number, rawInfo: undefined): void;
};
// Called on RingRTC's NativeCallManager, whose `observer` is RingRTC itself.
// Without peek info RingRTC reports a group call without participants.
function peekFindsNoCall(this: { observer: Observer }, requestId: number): void {
  this.observer.handlePeekResponse(requestId, 404, undefined);
}
const OUTSIDE_CALLS: Record<string, unknown> = {
  cm_getAudioInputs: noDevices,
  cm_getAudioOutputs: noDevices,
  cm_peekGroupCall: peekFindsNoCall,
};

const native = new Proxy(Object.create(null) as Record<PropertyKey, unknown>, {
  get(_target, property) {
    if (property === 'callEndpointPropertyKey') {
      return callEndpointPropertyKey;
    }
    if (typeof property === 'symbol' || property === 'then' || property === '__esModule') {
      return undefined;
    }
    if (SETTINGS.has(property)) {
      return ignore;
    }
    if (Object.hasOwn(OUTSIDE_CALLS, property)) {
      return OUTSIDE_CALLS[property];
    }
    return function ringrtcNotAvailable(): never {
      throw new NotAvailableInWebBuildError(
        `calling is not available in the web build (ringrtc ${property})`
      );
    };
  },
});

export default native;
