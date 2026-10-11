// SPDX-License-Identifier: AGPL-3.0-only
//
// The database side of the in-page main process: what ts/sql/main.main.ts
// (MainSQL) and app/sql_channel.main.ts do in Electron, for one SQL worker
// (web/sql/worker.ts) instead of a pool of four: the files can only be open
// in one place at a time.
//
// - The worker starts with the main process; SQL calls wait for it and
//   fail with its error if it could not open the database (another tab has
//   it, no key, no storage), so Desktop shows that error instead of hanging.
// - Writes wait while paused (pause-sql-writes), as in MainSQL.
// - On pagehide writes stop and the database is closed (checkpointed).
//
// Nothing here logs SQL arguments or results.

import { format } from 'node:util';

import { SqliteErrorKind } from '../../ts/sql/errors.std.ts';
import { redactAll } from '../../ts/util/privacy.node.ts';
import type {
  StorageInfo,
  WorkerRequest,
  WrappedWorkerRequest,
  WrappedWorkerResponse,
} from '../sql/protocol.ts';
import { handle, sendToRenderer } from './ipc.ts';
import { appendLogLine } from './logs.ts';
import { clearStored } from './storage.ts';

type Pending = {
  errorId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type StorageStatus = {
  info?: StorageInfo;
  error?: string;
  persisted?: boolean;
};

declare global {
  interface Window {
    // Read by the browser tests (web/renderer/run.mjs, web/sql/test).
    __webStorage?: StorageStatus;
  }
}

const LOG_LEVELS = { fatal: 60, error: 50, warn: 40, info: 30, debug: 20, trace: 10 } as const;

function log(level: keyof typeof LOG_LEVELS, message: string): void {
  appendLogLine(
    JSON.stringify({ level: LOG_LEVELS[level], time: new Date().toISOString(), msg: message })
  );
}

class WebSQL {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #seq = 0;
  #ready: Promise<StorageInfo>;
  #pauseWaiters: Array<() => void> | undefined;
  #closed = false;
  #checkpointPendingReason: string | null = null;
  #inFlight = 0;
  #started = false;
  #failed: Error | undefined;

  constructor(workerUrl: URL, init: { configDir: string; appVersion: string }) {
    this.#worker = new Worker(workerUrl, { type: 'module', name: 'sql' });
    this.#worker.addEventListener('message', event => this.#onMessage(event.data));
    this.#worker.addEventListener('error', event => {
      event.preventDefault();
      const message = `SQL worker error: ${event.message || 'the worker could not be loaded'}`;
      log('error', `MainSQL: ${redactAll(message)}`);
      // Before 'init' answered, the worker did not start: nothing will
      // answer. Later errors come from timers in the worker; requests still
      // get their responses.
      if (!this.#started) {
        this.#failed = new Error(message);
        this.#failAll(this.#failed);
      }
    });
    this.#worker.addEventListener('messageerror', () => {
      log('error', 'MainSQL: a worker message could not be deserialized');
    });
    this.#ready = this.#send({ type: 'init', ...init }) as Promise<StorageInfo>;
    this.#ready.then(
      () => {
        this.#started = true;
      },
      () => {
        this.#started = true;
      }
    );
  }

  get ready(): Promise<StorageInfo> {
    return this.#ready;
  }

  async sqlRead(method: string, args: ReadonlyArray<unknown>): Promise<unknown> {
    await this.#ready;
    return this.#send({ type: 'sqlCall:read', method, args });
  }

  async sqlWrite(method: string, args: ReadonlyArray<unknown>): Promise<unknown> {
    await this.#ready;
    while (this.#pauseWaiters != null) {
      const waiters = this.#pauseWaiters;
      // oxlint-disable-next-line no-await-in-loop
      await new Promise<void>(resolve => waiters.push(resolve));
    }
    return this.#send({ type: 'sqlCall:write', method, args });
  }

  pauseWriteAccess(): void {
    if (this.#pauseWaiters != null) {
      throw new Error('Already paused');
    }
    this.#pauseWaiters = [];
  }

  resumeWriteAccess(): void {
    const waiters = this.#pauseWaiters;
    if (waiters == null) {
      throw new Error('Not paused');
    }
    this.#pauseWaiters = undefined;
    for (const resolve of waiters) {
      resolve();
    }
  }

  async removeDB(): Promise<void> {
    // Like MainSQL: removal works whether or not the database opened.
    await this.#ready.catch(() => undefined);
    await this.#send({ type: 'removeDB' });
  }

  async eraseKey(): Promise<void> {
    await this.#ready.catch(() => undefined);
    await this.#send({ type: 'eraseKey' });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#pauseWaiters ??= [];
    void this.#send({ type: 'close' }).catch(() => undefined);
  }

  #send(request: WorkerRequest): Promise<unknown> {
    const errorId =
      request.type === 'sqlCall:read' || request.type === 'sqlCall:write'
        ? `${request.type}(${request.method})`
        : request.type;
    if (this.#failed) {
      return Promise.reject(new Error(`${errorId}: ${this.#failed.message}`));
    }
    if (this.#closed && request.type !== 'close') {
      return Promise.reject(new Error(`${errorId}: the database was closed (the page is unloading)`));
    }
    const seq = this.#seq;
    this.#seq = (this.#seq + 1) >>> 0;
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(seq, { errorId, resolve, reject });
    });
    const message: WrappedWorkerRequest = { seq, request };
    try {
      this.#worker.postMessage(message);
    } catch (error) {
      this.#pending.delete(seq);
      // Arguments that can't be cloned (Desktop serializes them with
      // node:v8, which has the same limits).
      return Promise.reject(
        new Error(`${errorId}: ${error instanceof Error ? error.message : String(error)}`)
      );
    }
    this.#inFlight += 1;
    return result.finally(() => {
      this.#inFlight -= 1;
      this.#maybeRunCheckpoint();
    });
  }

  #maybeRunCheckpoint(): void {
    if (this.#inFlight !== 0 || this.#checkpointPendingReason == null || this.#closed) {
      return;
    }
    const reason = this.#checkpointPendingReason;
    this.#checkpointPendingReason = null;
    void this.#send({ type: 'walCheckpoint', reason }).catch(error => {
      log('warn', `MainSQL: checkpoint failed: ${redactAll(String(error?.message))}`);
    });
  }

  #failAll(error: Error): void {
    for (const [seq, entry] of this.#pending) {
      this.#pending.delete(seq);
      entry.reject(new Error(`${entry.errorId}: ${error.message}`));
    }
  }

  #onMessage(message: WrappedWorkerResponse): void {
    if (message.type === 'log') {
      const [fmt, ...rest] = message.args;
      log(message.level, `MainSQL: ${redactAll(format(fmt, ...rest))}`);
      return;
    }
    if (message.type === 'walCheckpointNeeded') {
      this.#checkpointPendingReason = message.reason;
      this.#maybeRunCheckpoint();
      return;
    }
    const entry = this.#pending.get(message.seq);
    this.#pending.delete(message.seq);
    if (!entry) {
      log('error', `MainSQL: unexpected worker response with seq ${message.seq}`);
      return;
    }
    if (message.error) {
      const error = new Error(`${entry.errorId}: ${message.error.message}`);
      error.stack = `${entry.errorId}: ${message.error.stack}`;
      error.name = message.error.name;
      if (this.#started) {
        if (message.errorKind === SqliteErrorKind.Corrupted || message.errorKind === SqliteErrorKind.Readonly) {
          // Electron's main process shows its database error dialog here
          // (delete and restart); the web build's comes with the app shell.
          log('error', `MainSQL: database ${message.errorKind}: ${redactAll(message.error.message)}`);
        } else {
          // Desktop's renderer shows a toast for unknown SQL errors (not in
          // production builds).
          sendToRenderer('sql-error');
        }
      }
      entry.reject(error);
    } else {
      entry.resolve(message.response);
    }
  }
}

type Result = { ok: true; value: unknown } | { ok: false; error: Error };

async function wrapResult(fn: () => Promise<unknown>): Promise<Result> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

// OPFS directories under /userData that hold files outside the database;
// the web build does not store attachments yet (see .web-port notes), so
// erasing them only removes what may exist.
async function removeUserDataDirectory(name: string): Promise<void> {
  let userData: FileSystemDirectoryHandle;
  try {
    userData = await (await navigator.storage.getDirectory()).getDirectoryHandle('userData');
  } catch {
    return;
  }
  try {
    await userData.removeEntry(name, { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
      throw error;
    }
  }
}

/** Starts the SQL worker; resolves when it opened the database or failed. */
export function installSql({
  configDir,
  appVersion,
}: {
  configDir: string;
  appVersion: string;
}): Promise<void> {
  const status: StorageStatus = {};
  window.__webStorage = status;

  const sql = new WebSQL(new URL('sql/worker.js', document.baseURI), { configDir, appVersion });
  const started = performance.now();
  sql.ready.then(
    info => {
      status.info = info;
      log(
        'info',
        `MainSQL: database ${info.created ? 'created' : 'opened'} in ${Math.round(performance.now() - started)}ms ` +
          `(schema ${info.schemaVersion}, ${info.cipherVersion}, SQLite ${info.sqliteVersion}, ` +
          `steps ${JSON.stringify(info.timings)})`
      );
      if (info.created) {
        // Ask the browser not to evict the database under storage pressure.
        void (navigator.storage?.persist?.() ?? Promise.resolve(false)).then(
          persisted => {
            status.persisted = persisted;
            log('info', `MainSQL: persistent storage ${persisted ? 'granted' : 'not granted'}`);
          },
          () => {
            status.persisted = false;
          }
        );
      }
    },
    error => {
      status.error = `${error.name}: ${error.message}`;
      log('error', `MainSQL: database startup error: ${redactAll(status.error)}`);
    }
  );

  handle('sql-channel:read', (_event, name: unknown, args: unknown) =>
    wrapResult(() => sql.sqlRead(String(name), args as ReadonlyArray<unknown>))
  );
  handle('sql-channel:write', (_event, name: unknown, args: unknown) =>
    wrapResult(() => sql.sqlWrite(String(name), args as ReadonlyArray<unknown>))
  );
  handle('sql-channel:remove-db', () => sql.removeDB());
  handle('erase-sql-key', async () => {
    await sql.eraseKey();
    // Desktop also removes config.json and ephemeral.json here.
    clearStored();
  });
  handle('pause-sql-writes', () => sql.pauseWriteAccess());
  handle('resume-sql-writes', () => sql.resumeWriteAccess());

  handle('erase-attachments', () => removeUserDataDirectory('attachments.noindex'));
  handle('erase-stickers', () => removeUserDataDirectory('stickers.noindex'));
  handle('erase-temp', () => removeUserDataDirectory('temp'));
  handle('erase-drafts', () => removeUserDataDirectory('drafts.noindex'));
  handle('erase-downloads', () => removeUserDataDirectory('downloads.noindex'));
  // Nothing to clean or chmod: no attachment files yet, and OPFS has no
  // permissions.
  handle('cleanup-orphaned-attachments', () => undefined);
  handle('ensure-file-permissions', () => undefined);

  window.addEventListener('pagehide', () => sql.close());
  window.addEventListener('pageshow', event => {
    // Back from the back/forward cache: the database was closed on pagehide.
    if (event.persisted) {
      window.location.reload();
    }
  });

  return sql.ready.then(
    () => undefined,
    () => undefined
  );
}
