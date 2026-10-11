// SPDX-License-Identifier: AGPL-3.0-only
//
// node:v8. Desktop uses serialize/deserialize to pass values over its SQL IPC
// channel; in the browser the structured clone algorithm (what postMessage
// uses) gives the same value semantics, so serialize() makes a structured
// clone and deserialize() returns it. Heap introspection is not available.

import { unavailable } from './unavailable.ts';

export function serialize(value: unknown): unknown {
  return structuredClone(value);
}

export function deserialize(value: unknown): unknown {
  return value;
}

export const getHeapSnapshot = unavailable('v8', 'getHeapSnapshot');
export const writeHeapSnapshot = unavailable('v8', 'writeHeapSnapshot');

export function getHeapStatistics(): Record<string, number> {
  const memory = (performance as { memory?: Record<string, number> }).memory;
  return {
    total_heap_size: memory?.totalJSHeapSize ?? 0,
    used_heap_size: memory?.usedJSHeapSize ?? 0,
    heap_size_limit: memory?.jsHeapSizeLimit ?? 0,
  };
}

export default {
  serialize,
  deserialize,
  getHeapSnapshot,
  writeHeapSnapshot,
  getHeapStatistics,
};
