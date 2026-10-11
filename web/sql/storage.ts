// SPDX-License-Identifier: AGPL-3.0-only
//
// Where the database lives: SQLite3 Multiple Ciphers (WebAssembly) with its
// encrypting VFS on top of opfs-sahpool, a VFS on the origin private file
// system that works in a worker without cross-origin isolation (GitHub
// Pages can't send COOP/COEP headers). The pool's directory is
// OPFS:/userData/sql, mirroring Desktop's <userData>/sql/db.sqlite.
//
// One tab at a time: the worker holds an exclusive Web Lock for as long as
// it has the database, and only then touches the pool (opfs-sahpool keeps
// exclusive access handles on its files). A second tab gets
// DatabaseInUseError and leaves the files alone.

import sqlite3mc from 'sqlite3mc';
import type { SahPoolUtil, Sqlite3, Sqlite3InitModule } from './sqlite3.d.ts';
import { setEngine } from './sqlcipher.ts';
import { loadTokenizer } from './tokenizer.ts';
import { fetchModule, StorageUnavailableError } from './assets.ts';
import type { WasmAsset } from './protocol.ts';

export const USER_DATA = '/userData';
export const DATABASE_PATH = `${USER_DATA}/sql/db.sqlite`;
const POOL_DIRECTORY = 'userData/sql';
const POOL_VFS = 'receiver-opfs';
const LOCK_NAME = 'receiver:database';
// A reload starts the new page's worker while the old one is still shutting
// down: wait this long for it before reporting another tab.
const LOCK_WAIT_MS = 5000;
const MIN_FREE_SLOTS = 4;

const sqlite3InitModule = sqlite3mc as Sqlite3InitModule;

// FileSystemFileHandle in workers (not in TypeScript's DOM types).
type SyncFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<{ close(): void }>;
};

export class DatabaseInUseError extends Error {
  override name = 'DatabaseInUseError';
}

type Logger = { warn(...args: Array<unknown>): void };

export type Storage = {
  sqlite3: Sqlite3;
  pool: SahPoolUtil;
  release(): void;
};

let current: Storage | undefined;

export function getPool(): SahPoolUtil | undefined {
  return current?.pool;
}

function acquireLock(): Promise<() => void> {
  if (!navigator.locks) {
    return Promise.reject(new StorageUnavailableError('Web Locks are not available'));
  }
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(LOCK_NAME, { mode: 'exclusive', signal: AbortSignal.timeout(LOCK_WAIT_MS) }, () =>
        new Promise<void>(release => resolve(release))
      )
      .catch((error: unknown) => {
        if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
          reject(
            new DatabaseInUseError(
              'The database is in use by another tab. Close the other tab (or use the app there) and reload this one.'
            )
          );
        } else {
          reject(error);
        }
      });
  });
}

async function loadSqlite(module: WebAssembly.Module, logger: Logger): Promise<Sqlite3> {
  // sqlite3InitModule never settles if instantiation fails; race it.
  let fail: (error: unknown) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  return Promise.race([
    sqlite3InitModule({
      print: () => undefined,
      printErr: (...args) => logger.warn('sqlite3:', ...args),
      instantiateWasm(imports, onSuccess) {
        WebAssembly.instantiate(module, imports).then(instance => onSuccess(instance, module), fail);
        return {};
      },
    }),
    failed,
  ]);
}

// opfs-sahpool opens every file in its directory when installed, and on
// failure removes its directory. Make sure no other context (an old worker
// of this tab that is still shutting down) has a handle first.
async function waitForPoolFiles(): Promise<void> {
  let dir: FileSystemDirectoryHandle;
  try {
    let parent = await navigator.storage.getDirectory();
    for (const part of [...POOL_DIRECTORY.split('/'), '.opaque']) {
      parent = await parent.getDirectoryHandle(part);
    }
    dir = parent;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return;
    }
    throw error;
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      for await (const handle of dir.values()) {
        if (handle.kind === 'file') {
          const access = await (handle as SyncFileHandle).createSyncAccessHandle();
          access.close();
        }
      }
      return;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NoModificationAllowedError') || attempt >= 6) {
        if (error instanceof DOMException && error.name === 'NoModificationAllowedError') {
          throw new DatabaseInUseError('The database files are in use by another tab or window.');
        }
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
}

export type StorageTimings = Record<string, number>;

export async function openStorage(
  assets: { sqlite: WasmAsset; tokenizer: WasmAsset },
  base: string,
  logger: Logger,
  timings: StorageTimings
): Promise<Storage> {
  if (current) {
    return current;
  }
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = Math.round(now - t);
    t = now;
  };

  if (!navigator.storage?.getDirectory || !('createSyncAccessHandle' in (globalThis.FileSystemFileHandle?.prototype ?? {}))) {
    throw new StorageUnavailableError(
      'this browser has no origin private file system with synchronous access (needed for the database)'
    );
  }

  const [sqliteModule, tokenizerModule] = await Promise.all([
    fetchModule(assets.sqlite, base),
    fetchModule(assets.tokenizer, base),
  ]);
  const sqlite3 = await loadSqlite(sqliteModule, logger);
  await loadTokenizer(tokenizerModule);
  lap('wasm');

  const release = await acquireLock();
  lap('lock');
  try {
    await waitForPoolFiles();
    const pool = await sqlite3.installOpfsSAHPoolVfs({
      name: POOL_VFS,
      directory: POOL_DIRECTORY,
      initialCapacity: 8,
    });
    if (pool.getCapacity() - pool.getFileNames().length < MIN_FREE_SLOTS) {
      await pool.addCapacity(MIN_FREE_SLOTS);
    }
    const rc = sqlite3.capi.sqlite3mc_vfs_create(POOL_VFS, 0);
    if (rc !== 0) {
      throw new StorageUnavailableError(`cannot create the encrypting VFS (${rc})`);
    }
    setEngine(sqlite3, `multipleciphers-${POOL_VFS}`);
    lap('vfs');
    current = {
      sqlite3,
      pool,
      release() {
        try {
          if (!pool.isPaused()) {
            pool.pauseVfs();
          }
        } finally {
          current = undefined;
          release();
        }
      },
    };
    return current;
  } catch (error) {
    release();
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new StorageUnavailableError('the browser has no storage space left for the database');
    }
    if (error instanceof DOMException && error.name === 'NoModificationAllowedError') {
      throw new DatabaseInUseError('The database files are in use by another tab or window.');
    }
    throw error;
  }
}

export function databaseExists(pool: SahPoolUtil): boolean {
  return pool.getFileNames().includes(DATABASE_PATH);
}
