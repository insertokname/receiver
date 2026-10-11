// SPDX-License-Identifier: AGPL-3.0-only
// node:timers on the browser's timers. setImmediate runs the callback as a
// new task (MessageChannel), like Node's, without the 4 ms timeout clamp.

const pending = new Map<number, () => void>();
let nextId = 1;
const channel = new MessageChannel();
channel.port1.onmessage = ({ data }: MessageEvent<number>) => {
  const run = pending.get(data);
  pending.delete(data);
  run?.();
};

export type Immediate = { id: number; hasRef(): boolean; ref(): Immediate; unref(): Immediate };

export function setImmediate<A extends Array<unknown>>(
  callback: (...args: A) => void,
  ...args: A
): Immediate {
  const id = nextId;
  nextId += 1;
  pending.set(id, () => callback(...args));
  channel.port2.postMessage(id);
  const handle: Immediate = {
    id,
    hasRef: () => true,
    ref: () => handle,
    unref: () => handle,
  };
  return handle;
}

export function clearImmediate(handle: Immediate | undefined): void {
  if (handle) {
    pending.delete(handle.id);
  }
}

export const { setTimeout, clearTimeout, setInterval, clearInterval } =
  globalThis;

export default {
  setImmediate,
  clearImmediate,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
