// SPDX-License-Identifier: AGPL-3.0-only
//
// The SQL worker's request handling: Desktop's database code
// (ts/sql/Server.node.ts and its migrations, unchanged) on encrypted SQLite
// in the origin private file system (storage.ts). Requests are handled like
// ts/sql/mainWorker.node.ts handles them in Electron, with the storage
// steps (lock, key, files) added in front of 'init'. Loaded by worker.ts
// once libsignal is ready.
//
// Logs never contain SQL parameters, rows or the key: what is logged here
// are request names, timings and errors (Desktop's SQL errors carry SQLite's
// messages, not data).

import assets from 'virtual:web-sql-assets';

import type { WritableDB } from '../../ts/sql/Interface.std.ts';
import { initialize, DataReader, DataWriter, removeDB } from '../../ts/sql/Server.node.ts';
import { SqliteErrorKind, parseSqliteError } from '../../ts/sql/errors.std.ts';
import { sqlLogger as logger } from '../../ts/sql/sqlLogger.node.ts';
import { WalCheckpoints } from '../../ts/sql/WalCheckpoints.std.ts';
import { createKey, eraseKey, loadKey, DatabaseKeyError } from './key.ts';
import { databaseExists, DATABASE_PATH, openStorage } from './storage.ts';
import type { Storage } from './storage.ts';
import type { StorageInfo, WorkerRequest, WrappedWorkerRequest } from './protocol.ts';
import { respond, respondError, scope } from './respond.ts';

let storage: Storage | undefined;
let db: WritableDB | undefined;
let isRemoved = false;

async function init(configDir: string, appVersion: string): Promise<StorageInfo> {
  if (db) {
    throw new Error('Already initialized');
  }
  const timings: Record<string, number> = {};
  storage = await openStorage(assets, scope.location.href, logger, timings);
  try {
    let t = performance.now();
    const exists = databaseExists(storage.pool);
    let key = await loadKey();
    let created = !exists;
    if (key === undefined) {
      if (exists) {
        throw new DatabaseKeyError(
          'The database key is missing (site data was partly cleared), so the database cannot be decrypted'
        );
      }
      key = await createKey();
      created = true;
    } else if (!exists) {
      logger.warn('SQL worker: a key is stored but there is no database; creating a new one');
    }
    timings.key = Math.round(performance.now() - t);

    t = performance.now();
    WalCheckpoints.setOnCheckpointNeeded(reason => {
      scope.postMessage({ type: 'walCheckpointNeeded', reason });
    });
    db = initialize({ appVersion, configDir, key, isPrimary: true });
    timings.open = Math.round(performance.now() - t);

    const { capi } = storage.sqlite3;
    return {
      created,
      schemaVersion: Number(db.pragma('user_version', { simple: true })),
      sqliteVersion: capi.sqlite3_libversion(),
      cipherVersion: capi.sqlite3mc_version(),
      timings,
    };
  } catch (error) {
    // The files stay locked to this tab, so that remove-db (Desktop's
    // "delete all data") can still remove them.
    throw error;
  }
}

function closeDatabase(): void {
  if (db) {
    const current = db;
    db = undefined;
    DataWriter.close(current);
  }
}

async function remove(): Promise<void> {
  const hadDatabase = db !== undefined;
  try {
    closeDatabase();
  } catch (error) {
    logger.error('SQL worker: failed to close the database before removal', error);
  }
  if (hadDatabase) {
    removeDB();
  } else if (storage) {
    for (const path of [DATABASE_PATH, `${DATABASE_PATH}-wal`, `${DATABASE_PATH}-journal`]) {
      storage.pool.unlink(path);
    }
  } else {
    throw new Error('removeDB: the database is not open (in use by another tab?)');
  }
  await eraseKey();
  storage?.release();
  storage = undefined;
  isRemoved = true;
}

function sqlCall(
  request: Extract<WorkerRequest, { type: 'sqlCall:read' | 'sqlCall:write' }>
): unknown {
  if (!db) {
    throw new Error(isRemoved ? 'The database was removed' : 'Not initialized');
  }
  const DataInterface = request.type === 'sqlCall:read' ? DataReader : DataWriter;
  const method = (DataInterface as unknown as Record<string, unknown>)[request.method];
  if (typeof method !== 'function') {
    throw new Error(`Invalid sql method: ${request.method}`);
  }
  return method(db, ...request.args);
}

export async function onMessage(
  { seq, request }: WrappedWorkerRequest,
  isRetrying = false
): Promise<void> {
  try {
    switch (request.type) {
      case 'init':
        respond(seq, await init(request.configDir, request.appVersion));
        return;
      case 'close':
        closeDatabase();
        storage?.release();
        storage = undefined;
        respond(seq);
        return;
      case 'removeDB':
        await remove();
        respond(seq);
        return;
      case 'eraseKey':
        await eraseKey();
        respond(seq);
        return;
      case 'walCheckpoint':
        if (db) {
          WalCheckpoints.runImmediately(db, logger, request.reason);
        }
        respond(seq);
        return;
      case 'sqlCall:read':
      case 'sqlCall:write':
        respond(seq, sqlCall(request));
        return;
      default:
        throw new Error('Unexpected request type');
    }
  } catch (error) {
    const errorKind = parseSqliteError(error as Error);
    if (
      (errorKind === SqliteErrorKind.Corrupted || errorKind === SqliteErrorKind.Logic) &&
      db != null &&
      (request.type === 'sqlCall:read' || request.type === 'sqlCall:write')
    ) {
      const wasRecovered = DataWriter.runCorruptionChecks(db);
      if (wasRecovered && !isRetrying) {
        logger.error(`Retrying request: ${request.type}`);
        await onMessage({ seq, request }, true);
        return;
      }
    }
    respondError(seq, error);
  }
}
