// SPDX-License-Identifier: AGPL-3.0-only
//
// Messages between the page (web/main/sql.ts, in place of Electron's main
// process, ts/sql/main.main.ts) and the SQL worker (web/sql/worker.ts, in
// place of ts/sql/mainWorker.node.ts). Same shape as Desktop's
// WrappedWorkerRequest / WrappedWorkerResponse, with arguments and results
// passed as structured clones, plus the web build's storage requests.

import type { SqliteErrorKind } from '../../ts/sql/errors.std.ts';

export type WasmAsset = Readonly<{ path: string; integrity: string }>;

export type StorageInfo = Readonly<{
  // The database was created by this start (first run, or after erasing).
  created: boolean;
  schemaVersion: number;
  sqliteVersion: string;
  cipherVersion: string;
  // Milliseconds per step: wasm, lock, vfs, key, open (migrations included).
  timings: Readonly<Record<string, number>>;
}>;

export type WorkerRequest = Readonly<
  | { type: 'init'; configDir: string; appVersion: string }
  | { type: 'close' }
  | { type: 'removeDB' }
  | { type: 'eraseKey' }
  | { type: 'walCheckpoint'; reason: string }
  | {
      type: 'sqlCall:read' | 'sqlCall:write';
      method: string;
      args: ReadonlyArray<unknown>;
    }
>;

export type WrappedWorkerRequest = Readonly<{
  seq: number;
  request: WorkerRequest;
}>;

export type WorkerLogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export type WrappedWorkerResponse =
  | Readonly<{
      type: 'response';
      seq: number;
      error:
        | Readonly<{ name: string; message: string; stack: string | undefined }>
        | undefined;
      errorKind: SqliteErrorKind | undefined;
      response: unknown;
    }>
  | Readonly<{ type: 'walCheckpointNeeded'; reason: string }>
  | Readonly<{ type: 'log'; level: WorkerLogLevel; args: ReadonlyArray<unknown> }>;
