// SPDX-License-Identifier: AGPL-3.0-only
//
// node:fs inside the SQL worker, for what Desktop's SQL code does with
// files (ts/sql/Server.node.ts, migrations): create the database directory,
// remove the database files, delete leftover attachment files. The database
// files live in the opfs-sahpool VFS (storage.ts), whose namespace is flat:
// directories need no creating. The app's other files (attachments, drafts,
// avatars) belong to the page (web/main/files.ts): deleting one asks the
// page to (Desktop's callers ignore failures, which the page logs). Every
// other fs export throws "not available" (renderer/resolve.mjs, 'partial').

import { unavailable } from '../../renderer/shims/node/unavailable.ts';
import { getPool } from '../storage.ts';
import { scope } from '../respond.ts';

const USER_DATA = '/userData/';

/** Asks the page to delete one of the app's files; true if `path` is one. */
function removeAppFile(path: string): boolean {
  if (!path.startsWith(USER_DATA) || path.startsWith(`${USER_DATA}sql/`)) return false;
  scope.postMessage({ type: 'removeFile', path });
  return true;
}

function notFound(syscall: string, path: string): Error {
  const error = new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`);
  Object.assign(error, { code: 'ENOENT', errno: -2, syscall, path });
  return error;
}

// graceful-fs (bundled through fs-extra) checks for realpath.native.
export const realpath = Object.assign(unavailable('fs', 'realpath'), {
  native: unavailable('fs', 'realpath.native'),
});
export const realpathSync = Object.assign(unavailable('fs', 'realpathSync'), {
  native: unavailable('fs', 'realpathSync.native'),
});

export function mkdirSync(_path: string, _options?: unknown): undefined {
  return undefined;
}

export function existsSync(path: string): boolean {
  return getPool()?.getFileNames().includes(String(path)) ?? false;
}

export function rmSync(path: string, options?: { force?: boolean }): void {
  const pool = getPool();
  if (pool?.getFileNames().includes(String(path))) {
    pool.unlink(String(path));
    return;
  }
  if (removeAppFile(String(path))) return;
  if (!options?.force) {
    throw notFound('rm', String(path));
  }
}

export function unlinkSync(path: string): void {
  const pool = getPool();
  if (pool?.getFileNames().includes(String(path))) {
    pool.unlink(String(path));
    return;
  }
  if (removeAppFile(String(path))) return;
  throw notFound('unlink', String(path));
}
