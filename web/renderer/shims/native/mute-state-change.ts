// SPDX-License-Identifier: AGPL-3.0-only
//
// @signalapp/mute-state-change (system-wide microphone mute on macOS): the
// browser has no such state. Same no-op behaviour as the package on
// platforms it does not support.

export function isMuted(): boolean | undefined {
  return undefined;
}

export function setIsMuted(_newValue: boolean): void {}

export function subscribe(_fn: (isMuted: boolean) => void): boolean {
  return false;
}

export function unsubscribe(_fn: (isMuted: boolean) => void): boolean {
  return false;
}
