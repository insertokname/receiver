// SPDX-License-Identifier: AGPL-3.0-only
//
// node:process (and the `process` global) on the `process` package, with
// what Desktop's renderer reads from it. The web build reports itself as
// Linux: it has none of the macOS / Windows native integrations, and Linux
// is the platform whose code paths need the fewest of them.

import base from 'process/browser.js';

import { unavailable } from './unavailable.ts';

type MemoryInfo = {
  totalJSHeapSize?: number;
  usedJSHeapSize?: number;
};

const startedAt = performance.now();

// stdout/stderr write to the console. (Plain objects with an own write():
// pino then uses them as they are instead of opening a file descriptor.)
const stdio = (fd: number, method: 'log' | 'error') => ({
  fd,
  isTTY: false,
  writable: true,
  write(chunk: unknown): boolean {
    // oxlint-disable-next-line no-console
    console[method](String(chunk).replace(/\n$/, ''));
    return true;
  },
  on() {
    return this;
  },
  once() {
    return this;
  },
  removeListener() {
    return this;
  },
});

const process = Object.assign(base, {
  platform: 'linux',
  arch: 'x64',
  type: 'renderer',
  mas: false,
  windowsStore: false,
  sandboxed: false,
  contextIsolated: false,
  version: 'v24.0.0',
  versions: { node: '24.0.0', web: '1' },
  env: { NODE_ENV: 'production' } as Record<string, string | undefined>,
  argv: [] as Array<string>,
  stdout: stdio(1, 'log'),
  stderr: stdio(2, 'error'),
  pid: 1,
  ppid: 0,
  execPath: '/',
  resourcesPath: '/',
  cwd: () => '/',
  uptime: () => (performance.now() - startedAt) / 1000,
  hrtime: Object.assign(
    (previous?: [number, number]): [number, number] => {
      const now = performance.now();
      const seconds = Math.floor(now / 1000);
      const nanos = Math.floor((now % 1000) * 1e6);
      if (!previous) {
        return [seconds, nanos];
      }
      let ds = seconds - previous[0];
      let dn = nanos - previous[1];
      if (dn < 0) {
        ds -= 1;
        dn += 1e9;
      }
      return [ds, dn];
    },
    { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }
  ),
  memoryUsage: () => {
    const memory = (performance as { memory?: MemoryInfo }).memory;
    return {
      rss: memory?.totalJSHeapSize ?? 0,
      heapTotal: memory?.totalJSHeapSize ?? 0,
      heapUsed: memory?.usedJSHeapSize ?? 0,
      external: 0,
      arrayBuffers: 0,
    };
  },
  nextTick: <A extends Array<unknown>>(
    callback: (...args: A) => void,
    ...args: A
  ) => queueMicrotask(() => callback(...args)),
  emitWarning: (warning: unknown) => {
    // oxlint-disable-next-line no-console
    console.warn('process warning', warning);
  },
  getSystemVersion: () => '',
  exit: unavailable('process', 'exit'),
  kill: unavailable('process', 'kill'),
  abort: unavailable('process', 'abort'),
  dlopen: unavailable('process', 'dlopen'),
});

export default process;
export const {
  platform,
  arch,
  env,
  argv,
  versions,
  nextTick,
  memoryUsage,
  hrtime,
  uptime,
  cwd,
} = process;
