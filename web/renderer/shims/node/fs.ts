// SPDX-License-Identifier: AGPL-3.0-only
//
// node:fs for the renderer: the part Desktop (and fs-extra, which it uses
// through graceful-fs) needs, on the app's files in the origin private file
// system (web/main/files.ts): callback functions, streams, and the
// synchronous questions the in-memory directory tree can answer (existsSync,
// realpathSync). Paths outside userData fail with EACCES. Every other export
// throws "not available" (renderer/resolve.mjs, 'partial').

import { checkScope, fsError, kindOf, normalizePath } from '../../../main/files.ts';
import * as promises from './fs-promises.ts';
import { ReadStream, WriteStream } from './fs-streams.ts';
import type { ReadStreamOptions, WriteStreamOptions } from './fs-streams.ts';

export { promises, ReadStream, WriteStream };
export { constants, Dirent, Stats } from './fs-promises.ts';

type Callback = (error: Error | null, value?: unknown) => void;

/** A callback-style function from a promise-returning one: the callback is the last argument. */
function withCallback(fn: (...args: Array<never>) => Promise<unknown>): (...args: Array<unknown>) => void {
  return (...args: Array<unknown>) => {
    const callback = args.pop();
    if (typeof callback !== 'function') {
      throw Object.assign(new TypeError('The "cb" argument must be of type function'), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    (fn as (...a: Array<unknown>) => Promise<unknown>)(...args).then(
      value => (callback as Callback)(null, value),
      error => (callback as Callback)(error)
    );
  };
}

export const stat = withCallback(promises.stat);
export const lstat = withCallback(promises.lstat);
export const access = withCallback(promises.access);
export const mkdir = withCallback(promises.mkdir);
export const readdir = withCallback(promises.readdir);
export const readFile = withCallback(promises.readFile);
export const writeFile = withCallback(promises.writeFile);
export const appendFile = withCallback(promises.appendFile);
export const unlink = withCallback(promises.unlink);
export const rm = withCallback(promises.rm);
export const rmdir = withCallback(promises.rmdir);
export const rename = withCallback(promises.rename);
export const copyFile = withCallback(promises.copyFile);
export const chmod = withCallback(promises.chmod);
export const lchmod = withCallback(promises.lchmod);
export const chown = withCallback(promises.chown);
export const lchown = withCallback(promises.lchown);
export const utimes = withCallback(promises.utimes);
export const lutimes = withCallback(promises.lutimes);
export const statfs = withCallback(promises.statfs);
export const realpath = Object.assign(withCallback(promises.realpath), {
  native: withCallback(promises.realpath),
});

/** Deprecated in Node, still used by some packages. */
export function exists(path: unknown, callback: (exists: boolean) => void): void {
  let result = false;
  try {
    result = existsSync(path);
  } catch {
    result = false;
  }
  queueMicrotask(() => callback(result));
}

export function existsSync(path: unknown): boolean {
  let normalized: string;
  try {
    normalized = normalizePath(path);
  } catch {
    return false;
  }
  return kindOf(normalized) !== undefined;
}

function realpathSyncImpl(path: unknown): string {
  const normalized = normalizePath(path);
  checkScope(normalized, 'realpath');
  if (!kindOf(normalized)) throw fsError('ENOENT', 'realpath', normalized);
  return normalized;
}
export const realpathSync = Object.assign(realpathSyncImpl, { native: realpathSyncImpl });

export function createReadStream(path: unknown, options?: ReadStreamOptions | BufferEncoding): ReadStream {
  return new ReadStream(path, options);
}

export function createWriteStream(path: unknown, options?: WriteStreamOptions | BufferEncoding): WriteStream {
  return new WriteStream(path, options);
}
