// SPDX-License-Identifier: AGPL-3.0-only
//
// `@signalapp/sqlcipher` for the web build: the same API (Database,
// Statement, setLogger) and the same semantics as its Node addon
// (github.com/signalapp/node-sqlcipher, lib/index.ts and src/addon.cc,
// version 4.1.0), on SQLite3 Multiple Ciphers compiled to WebAssembly.
//
// Differences from the addon, all on the storage side:
// - Every database is opened on the encrypting VFS set up by storage.ts
//   (SQLite3 Multiple Ciphers over opfs-sahpool) in SQLCipher 4 format, so
//   `PRAGMA key = "x'...'"` works as with SQLCipher.
// - One connection owns the files (opfs-sahpool holds exclusive handles), so
//   the connection uses exclusive locking; that is also what lets WAL work
//   without shared memory.
// - Temporary tables, indices and spills stay in memory: SQLite3 Multiple
//   Ciphers does not encrypt temporary files.
// - setWalHook: sqlite3_wal_hook is not exported by the WebAssembly build;
//   SQLite's own automatic checkpoints (every 1000 pages) stay in place.
// - setLogger: the WebAssembly build initializes SQLite before the logger
//   could be configured; errors still surface as exceptions.
// - scanStats is not available, as in the addon's production builds.

import { Buffer } from 'node:buffer';

import type { Pointer, Sqlite3 } from './sqlite3.d.ts';
import { registerSignalTokenizer, signalTokenize } from './tokenizer.ts';

export type RunResult = {
  changes: number;
  lastInsertRowid: number;
};

export type StatementOptions = Readonly<{
  persistent?: boolean;
  pluck?: true;
  bigint?: true;
}>;

export type SqliteValue<Options extends StatementOptions> =
  | string
  | Uint8Array<ArrayBuffer>
  | number
  | null
  | (Options extends { bigint: true } ? bigint : never);

export type NativeParameters<Options extends StatementOptions> = ReadonlyArray<
  SqliteValue<Options>
>;

export type StatementParameters<Options extends StatementOptions> =
  | NativeParameters<Options>
  | Readonly<Record<string, SqliteValue<Options>>>;

export type RowType<Options extends StatementOptions> = Options extends {
  pluck: true;
}
  ? SqliteValue<Options>
  : Record<string, SqliteValue<Options>>;

export type FunctionOptions = Readonly<{
  bigint?: boolean;
}>;

export type PragmaOptions = Readonly<{
  simple?: true;
}>;

export type PragmaResult<Options extends PragmaOptions> = Options extends {
  simple: true;
}
  ? RowType<{ pluck: true }> | undefined
  : Array<RowType<object>>;

export type ScanStats = Readonly<{
  id: number;
  parent: number;
  cycles: number;
  loops: number;
  rows: number;
  explain: string | null;
}>;

export type DatabaseOptions = Readonly<{
  cacheStatements?: boolean;
}>;

export type WalHook = (dbName: string, pageCount: number) => void;

// Set by storage.ts before Desktop's SQL code opens a database.
let engine: { sqlite3: Sqlite3; vfs: string } | undefined;

export function setEngine(sqlite3: Sqlite3, vfs: string): void {
  engine = { sqlite3, vfs };
}

function getEngine(): Sqlite3 {
  if (!engine) {
    throw new Error('sqlcipher: the SQLite engine is not loaded');
  }
  return engine.sqlite3;
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

// SQLite constants (sqlite3.h).
const SQLITE_OK = 0;
const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const SQLITE_INTEGER = 1;
const SQLITE_FLOAT = 2;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;
const SQLITE_NULL = 5;
const SQLITE_UTF8 = 1;
const SQLITE_PREPARE_PERSISTENT = 0x01;
const SQLITE_STMTSTATUS_REPREPARE = 5;
const SQLITE_OPEN_READWRITE = 0x02;
const SQLITE_OPEN_CREATE = 0x04;
const SQLITE_OPEN_EXRESCODE = 0x02000000;

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

type Exports = {
  sqlite3_step(p: Pointer): number;
  sqlite3_reset(p: Pointer): number;
  sqlite3_clear_bindings(p: Pointer): number;
  sqlite3_finalize(p: Pointer): number;
  sqlite3_bind_parameter_count(p: Pointer): number;
  sqlite3_bind_null(p: Pointer, i: number): number;
  sqlite3_bind_double(p: Pointer, i: number, v: number): number;
  sqlite3_bind_int64(p: Pointer, i: number, v: bigint): number;
  sqlite3_bind_text(p: Pointer, i: number, s: Pointer, n: number, d: number): number;
  sqlite3_bind_blob(p: Pointer, i: number, s: Pointer, n: number, d: number): number;
  sqlite3_bind_zeroblob(p: Pointer, i: number, n: number): number;
  sqlite3_column_count(p: Pointer): number;
  sqlite3_column_type(p: Pointer, i: number): number;
  sqlite3_column_int64(p: Pointer, i: number): bigint;
  sqlite3_column_double(p: Pointer, i: number): number;
  sqlite3_column_text(p: Pointer, i: number): Pointer;
  sqlite3_column_blob(p: Pointer, i: number): Pointer;
  sqlite3_column_bytes(p: Pointer, i: number): number;
  sqlite3_stmt_status(p: Pointer, op: number, reset: number): number;
  sqlite3_total_changes(db: Pointer): number;
  sqlite3_changes(db: Pointer): number;
  sqlite3_last_insert_rowid(db: Pointer): bigint;
};

function exportsOf(sqlite3: Sqlite3): Exports {
  return sqlite3.wasm.exports as unknown as Exports;
}

function formatSqliteError(sqlite3: Sqlite3, pDb: Pointer): Error {
  const { capi } = sqlite3;
  const message = capi.sqlite3_errmsg(pDb);
  const offset = capi.sqlite3_error_offset(pDb);
  const extended = capi.sqlite3_extended_errcode(pDb);
  const name = capi.sqlite3_js_rc_str(extended) ?? 'unknown';
  const error = new Error(
    offset === -1
      ? `sqlite error(${name}): ${message}`
      : `sqlite error(${name}): ${message}, offset: ${offset}`
  );
  (error as Error & { code: string }).code = name;
  return error;
}

// Mirrors the addon's HasTail(): only whitespace, ';' and comments may
// follow the first statement.
function hasTail(tail: string): boolean {
  let p = tail;
  while (p.length > 0) {
    const ch = p.charAt(0);
    if (/\s/.test(ch) || ch === ';') {
      p = p.slice(1);
    } else if (p.startsWith('--')) {
      const end = p.indexOf('\n', 2);
      if (end === -1) {
        return false;
      }
      p = p.slice(end + 1);
    } else if (p.startsWith('/*')) {
      const end = p.indexOf('*/', 2);
      if (end === -1) {
        return false;
      }
      p = p.slice(end + 2);
    } else {
      return true;
    }
  }
  return false;
}

type NativeDatabase = {
  sqlite3: Sqlite3;
  pDb: Pointer;
  statements: Set<NativeStatement>;
};

type NativeStatement = {
  db: NativeDatabase;
  pStmt: Pointer;
  isPersistent: boolean;
  isPluck: boolean;
  isBigint: boolean;
  columnNames: Array<string> | undefined;
};

// Statements Desktop prepares without keeping them (non-persistent ones) are
// finalized when garbage collected, as the addon does.
const statementRegistry = new FinalizationRegistry<NativeStatement>(native => {
  finalizeNative(native);
});

function finalizeNative(native: NativeStatement): number {
  if (native.pStmt === 0) {
    return SQLITE_OK;
  }
  const rc = exportsOf(native.db.sqlite3).sqlite3_finalize(native.pStmt);
  native.pStmt = 0;
  native.db.statements.delete(native);
  return rc;
}

function prepareNative(
  db: NativeDatabase,
  query: string,
  { persistent, pluck, bigint }: StatementOptions,
  paramNames: Array<string | null>
): NativeStatement {
  const { sqlite3, pDb } = db;
  const { wasm, capi } = sqlite3;
  const [pSql, nSql] = wasm.allocCString(query, true);
  const stack = wasm.pstack.pointer;
  try {
    const ppStmt = wasm.pstack.allocPtr();
    const pzTail = wasm.pstack.allocPtr();
    const rc = capi.sqlite3_prepare_v3(
      pDb,
      pSql,
      nSql,
      persistent ? SQLITE_PREPARE_PERSISTENT : 0,
      ppStmt,
      pzTail
    );
    if (rc !== SQLITE_OK) {
      throw formatSqliteError(sqlite3, pDb);
    }
    const pStmt = wasm.peekPtr(ppStmt);
    if (pStmt === 0) {
      // Only whitespace or comments: SQLite compiles nothing.
      throw new Error('Empty statement');
    }
    const tailPtr = wasm.peekPtr(pzTail);
    const tail = textDecoder.decode(
      wasm.heap8u().subarray(tailPtr, pSql + nSql)
    );
    const native: NativeStatement = {
      db,
      pStmt,
      isPersistent: persistent === true,
      isPluck: pluck === true,
      isBigint: bigint === true,
      columnNames: undefined,
    };
    db.statements.add(native);
    if (hasTail(tail)) {
      const frc = finalizeNative(native);
      if (frc === SQLITE_OK) {
        throw new Error("Can't prepare more than one statement");
      }
      throw formatSqliteError(sqlite3, pDb);
    }
    const count = exportsOf(sqlite3).sqlite3_bind_parameter_count(pStmt);
    for (let i = 1; i <= count; i += 1) {
      const name = capi.sqlite3_bind_parameter_name(pStmt, i);
      // Skip the "$" / ":" / "@" prefix.
      paramNames.push(name == null ? null : name.slice(1));
    }
    return native;
  } finally {
    wasm.pstack.restore(stack);
    wasm.dealloc(pSql);
  }
}

function resetNative(native: NativeStatement): void {
  const ex = exportsOf(native.db.sqlite3);
  ex.sqlite3_reset(native.pStmt);
  ex.sqlite3_clear_bindings(native.pStmt);
}

function bindParam(
  native: NativeStatement,
  index: number,
  param: unknown
): string | undefined {
  const { sqlite3, pDb } = native.db;
  const { wasm, capi } = sqlite3;
  const ex = exportsOf(sqlite3);
  const { pStmt } = native;
  let rc: number;
  if (param === null) {
    rc = ex.sqlite3_bind_null(pStmt, index);
  } else if (typeof param === 'number') {
    rc = ex.sqlite3_bind_double(pStmt, index, param);
  } else if (typeof param === 'string') {
    const [p, n] = wasm.allocCString(param, true);
    rc = ex.sqlite3_bind_text(pStmt, index, p, n, capi.SQLITE_WASM_DEALLOC);
  } else if (typeof param === 'bigint') {
    if (param < INT64_MIN || param > INT64_MAX) {
      return 'failed to convert bigint to int64';
    }
    rc = ex.sqlite3_bind_int64(pStmt, index, param);
  } else if (ArrayBuffer.isView(param) && !(param instanceof DataView)) {
    const bytes = new Uint8Array(param.buffer, param.byteOffset, param.byteLength);
    if (bytes.byteLength === 0) {
      rc = ex.sqlite3_bind_zeroblob(pStmt, index, 0);
    } else {
      const p = wasm.alloc(bytes.byteLength);
      wasm.heap8u().set(bytes, p);
      rc = ex.sqlite3_bind_blob(
        pStmt,
        index,
        p,
        bytes.byteLength,
        capi.SQLITE_WASM_DEALLOC
      );
    }
  } else {
    return `unexpected type \`${typeof param}\``;
  }
  if (rc !== SQLITE_OK) {
    return capi.sqlite3_errmsg(pDb);
  }
  return undefined;
}

// `params`: undefined (no parameters), null (keep the bindings, see all()),
// or the array of values.
function bindParams(
  native: NativeStatement,
  params: ReadonlyArray<unknown> | null | undefined
): void {
  const { sqlite3 } = native.db;
  const keyCount = exportsOf(sqlite3).sqlite3_bind_parameter_count(
    native.pStmt
  );
  if (params === null) {
    return;
  }
  if (params === undefined) {
    if (keyCount === 0) {
      return;
    }
    throw new Error(`Expected ${keyCount} parameters, got 0`);
  }
  if (params.length !== keyCount) {
    throw new Error(
      `Expected ${keyCount} parameters, got ${params.length}`
    );
  }
  for (let i = 1; i <= params.length; i += 1) {
    const error = bindParam(native, i, params[i - 1]);
    if (error !== undefined) {
      const name = sqlite3.capi.sqlite3_bind_parameter_name(native.pStmt, i);
      throw new Error(
        name == null
          ? `Failed to bind param ${i}, error ${error}`
          : `Failed to bind param ${name.slice(1)}, error ${error}`
      );
    }
  }
}

function columnValue(native: NativeStatement, column: number): unknown {
  const { sqlite3 } = native.db;
  const ex = exportsOf(sqlite3);
  const { pStmt } = native;
  switch (ex.sqlite3_column_type(pStmt, column)) {
    case SQLITE_INTEGER: {
      const value = BigInt(ex.sqlite3_column_int64(pStmt, column));
      if (native.isBigint) {
        return value;
      }
      const n = Number(value);
      return n >= INT32_MIN && n <= INT32_MAX ? n | 0 : n;
    }
    case SQLITE_FLOAT:
      return ex.sqlite3_column_double(pStmt, column);
    case SQLITE_TEXT: {
      const p = ex.sqlite3_column_text(pStmt, column);
      const n = ex.sqlite3_column_bytes(pStmt, column);
      return textDecoder.decode(sqlite3.wasm.heap8u().subarray(p, p + n));
    }
    case SQLITE_BLOB: {
      const p = ex.sqlite3_column_blob(pStmt, column);
      const n = ex.sqlite3_column_bytes(pStmt, column);
      const out = Buffer.allocUnsafe(n);
      if (n > 0) {
        out.set(sqlite3.wasm.heap8u().subarray(p, p + n));
      }
      return out;
    }
    case SQLITE_NULL:
      return null;
    default:
      return undefined;
  }
}

function columnNames(native: NativeStatement, count: number): Array<string> {
  const { sqlite3 } = native.db;
  // A schema change recompiles the statement; its columns may differ.
  const recompiled = exportsOf(sqlite3).sqlite3_stmt_status(
    native.pStmt,
    SQLITE_STMTSTATUS_REPREPARE,
    1
  );
  if (native.columnNames === undefined || recompiled !== 0) {
    const names = new Array<string>(count);
    for (let i = 0; i < count; i += 1) {
      names[i] = sqlite3.capi.sqlite3_column_name(native.pStmt, i);
    }
    native.columnNames = names;
  }
  return native.columnNames;
}

function throwStepError(native: NativeStatement): never {
  throw formatSqliteError(native.db.sqlite3, native.db.pDb);
}

// One step, as the addon's statementStep: returns undefined when there are
// no more rows. `isGet` resets the statement after the row.
function stepNative(
  native: NativeStatement,
  params: ReadonlyArray<unknown> | null | undefined,
  isGet: boolean
): unknown {
  bindParams(native, params);
  const rc = exportsOf(native.db.sqlite3).sqlite3_step(native.pStmt);
  try {
    if (rc === SQLITE_DONE) {
      resetNative(native);
      return undefined;
    }
    if (rc !== SQLITE_ROW) {
      const error = formatSqliteError(native.db.sqlite3, native.db.pDb);
      resetNative(native);
      throw error;
    }
    const count = exportsOf(native.db.sqlite3).sqlite3_column_count(
      native.pStmt
    );
    if (native.isPluck) {
      if (count !== 1) {
        resetNative(native);
        throw new Error('Invalid column count for pluck');
      }
      return columnValue(native, 0);
    }
    const names = native.isPersistent
      ? columnNames(native, count)
      : Array.from({ length: count }, (_, i) =>
          native.db.sqlite3.capi.sqlite3_column_name(native.pStmt, i)
        );
    const row: Record<string, unknown> = {};
    for (let i = 0; i < count; i += 1) {
      row[names[i] ?? String(i)] = columnValue(native, i);
    }
    return row;
  } finally {
    if (isGet && native.pStmt !== 0) {
      resetNative(native);
    }
  }
}

class Statement<Options extends StatementOptions = object> {
  #native: NativeStatement | undefined;
  readonly #translateParams: (
    params: StatementParameters<Options>
  ) => NativeParameters<Options>;
  readonly #onClose: (() => void) | undefined;

  constructor(
    db: NativeDatabase,
    query: string,
    options: Options,
    onClose?: () => void
  ) {
    const paramNames = new Array<string | null>();
    const native = prepareNative(db, query, options, paramNames);
    this.#native = native;
    statementRegistry.register(this, native, native);

    const isArrayParams = paramNames.every(name => name === null);
    const isObjectParams =
      !isArrayParams && paramNames.every(name => typeof name === 'string');
    if (!isArrayParams && !isObjectParams) {
      throw new TypeError('Cannot mix named and anonymous params in query');
    }

    if (isArrayParams) {
      this.#translateParams = params => {
        if (!Array.isArray(params)) {
          throw new TypeError('Query requires an array of anonymous params');
        }
        return params as NativeParameters<Options>;
      };
    } else {
      const names = paramNames as Array<string>;
      this.#translateParams = params => {
        if (Array.isArray(params)) {
          throw new TypeError('Query requires an object of named params');
        }
        const record = params as Readonly<Record<string, SqliteValue<Options>>>;
        return names.map(name => record[name]) as NativeParameters<Options>;
      };
    }
    this.#onClose = onClose;
  }

  public run(params?: StatementParameters<Options>): RunResult {
    const native = this.#open();
    const nativeParams = this.#checkParams(params);
    const ex = exportsOf(native.db.sqlite3);
    bindParams(native, nativeParams);
    const before = ex.sqlite3_total_changes(native.db.pDb);
    const rc = ex.sqlite3_step(native.pStmt);
    if (rc !== SQLITE_DONE && rc !== SQLITE_ROW) {
      const error = formatSqliteError(native.db.sqlite3, native.db.pDb);
      resetNative(native);
      throw error;
    }
    resetNative(native);
    const after = ex.sqlite3_total_changes(native.db.pDb);
    return {
      changes: after === before ? 0 : ex.sqlite3_changes(native.db.pDb),
      lastInsertRowid: Number(ex.sqlite3_last_insert_rowid(native.db.pDb)),
    };
  }

  public get<Row extends RowType<Options> = RowType<Options>>(
    params?: StatementParameters<Options>
  ): Row | undefined {
    const native = this.#open();
    return stepNative(native, this.#checkParams(params), true) as
      | Row
      | undefined;
  }

  public all<Row extends RowType<Options> = RowType<Options>>(
    params?: StatementParameters<Options>
  ): Array<Row> {
    const native = this.#open();
    const result = new Array<Row>();
    let singleUseParams: NativeParameters<Options> | undefined | null =
      this.#checkParams(params);
    while (true) {
      const row = stepNative(native, singleUseParams, false);
      singleUseParams = null;
      if (row === undefined) {
        break;
      }
      result.push(row as Row);
    }
    return result;
  }

  public scanStats(): Array<ScanStats> {
    this.#open();
    throw new Error('Not available in production builds');
  }

  public close(): void {
    if (this.#native === undefined) {
      throw new Error('Statement already closed');
    }
    const native = this.#native;
    this.#native = undefined;
    statementRegistry.unregister(native);
    if (native.pStmt !== 0) {
      const rc = finalizeNative(native);
      if (rc !== SQLITE_OK) {
        throwStepError(native);
      }
    }
    this.#onClose?.();
  }

  #open(): NativeStatement {
    const native = this.#native;
    if (native === undefined || native.pStmt === 0) {
      throw new Error('Statement closed');
    }
    return native;
  }

  #checkParams(
    params: StatementParameters<Options> | undefined
  ): NativeParameters<Options> | undefined {
    if (params === undefined) {
      return undefined;
    }
    if (typeof params !== 'object') {
      throw new TypeError('Params must be either object or array');
    }
    if (params === null) {
      throw new TypeError('Params cannot be null');
    }
    return this.#translateParams(params);
  }
}

export { type Statement };

type TransactionStatement = Statement<{ persistent: true; pluck: true }>;

export default class Database {
  #native: NativeDatabase | undefined;
  #transactionDepth = 0;
  readonly #isCacheEnabled: boolean;
  readonly #statementCache = new Map<string, Statement>();

  #transactionStmts:
    | Readonly<{
        begin: TransactionStatement;
        rollback: TransactionStatement;
        commit: TransactionStatement;
        savepoint: TransactionStatement;
        rollbackTo: TransactionStatement;
        release: TransactionStatement;
      }>
    | undefined;

  constructor(path = ':memory:', { cacheStatements }: DatabaseOptions = {}) {
    if (typeof path !== 'string') {
      throw new TypeError('Invalid database path');
    }
    const sqlite3 = getEngine();
    const { wasm, capi } = sqlite3;
    const isFile = path !== ':memory:' && path !== '';
    const stack = wasm.pstack.pointer;
    let pDb = 0;
    try {
      const ppDb = wasm.pstack.allocPtr();
      const rc = capi.sqlite3_open_v2(
        path,
        ppDb,
        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_EXRESCODE,
        isFile ? (engine?.vfs ?? null) : null
      );
      pDb = wasm.peekPtr(ppDb);
      if (rc !== SQLITE_OK) {
        const message = `sqlite open error: ${capi.sqlite3_errstr(rc)}`;
        if (pDb !== 0) {
          capi.sqlite3_close_v2(pDb);
        }
        throw new Error(message);
      }
    } finally {
      wasm.pstack.restore(stack);
    }
    this.#native = { sqlite3, pDb, statements: new Set() };
    this.#isCacheEnabled = cacheStatements === true;

    if (isFile) {
      try {
        // SQLCipher 4's format, which Desktop's SQLCipher writes; the key
        // itself comes from Desktop's `PRAGMA key`.
        this.exec("PRAGMA cipher = 'sqlcipher'; PRAGMA legacy = 4;");
        this.exec('PRAGMA locking_mode = EXCLUSIVE; PRAGMA temp_store = MEMORY;');
      } catch (error) {
        this.close();
        throw error;
      }
    }
  }

  public initTokenizer(): void {
    const native = this.#open();
    registerSignalTokenizer(native.sqlite3, native.pDb);
  }

  public exec(sql: string): void {
    const native = this.#open();
    if (typeof sql !== 'string') {
      throw new TypeError('Invalid sql argument');
    }
    const rc = native.sqlite3.capi.sqlite3_exec(native.pDb, sql, 0, 0, 0);
    if (rc !== SQLITE_OK) {
      throw formatSqliteError(native.sqlite3, native.pDb);
    }
  }

  public createFunction(
    name: string,
    fn: (...args: ReadonlyArray<unknown>) => void,
    options: FunctionOptions = {}
  ): void {
    const native = this.#open();
    if (typeof name !== 'string') {
      throw new TypeError('Invalid name argument');
    }
    if (typeof fn !== 'function') {
      throw new TypeError('Invalid fn argument');
    }
    const { bigint = false } = options;
    // SQLite's wrapper converts the arguments (integers that fit a double
    // become numbers, the rest BigInt), reports a thrown error as the
    // function's error and an undefined result as NULL.
    const rc = native.sqlite3.capi.sqlite3_create_function_v2(
      native.pDb,
      name,
      -1,
      SQLITE_UTF8,
      0,
      (_pCtx: Pointer, ...args: Array<unknown>) => {
        const converted = args.map(arg => {
          if (bigint && typeof arg === 'number' && Number.isInteger(arg)) {
            return BigInt(arg);
          }
          if (!bigint && typeof arg === 'bigint') {
            return Number(arg);
          }
          if (arg instanceof Uint8Array) {
            return Buffer.from(arg);
          }
          return arg;
        });
        const result = fn(...converted) as unknown;
        if (result !== undefined) {
          throw new Error('Function must not return a value');
        }
        return undefined;
      },
      0,
      0,
      0
    );
    if (rc !== SQLITE_OK) {
      throw formatSqliteError(native.sqlite3, native.pDb);
    }
  }

  public setWalHook(fn: WalHook): void {
    this.#open();
    if (typeof fn !== 'function') {
      throw new TypeError('Invalid fn argument');
    }
  }

  public prepare<Options extends StatementOptions = StatementOptions>(
    query: string,
    options: Options
  ): Statement<Options>;

  public prepare(query: string): Statement<object>;

  public prepare<Options extends StatementOptions = StatementOptions>(
    query: string,
    options: Options = {} as Options
  ): Statement<Options> {
    const native = this.#open();
    if (typeof query !== 'string') {
      throw new TypeError('Invalid query argument');
    }

    if (!this.#isCacheEnabled || options.persistent === false) {
      return new Statement(native, query, options);
    }

    // Persistent statements are cached until closed.
    const cacheKey = `${options.pluck}:${options.bigint}:${query}`;
    const cached = this.#statementCache.get(cacheKey);
    if (cached !== undefined) {
      return cached as Statement<Options>;
    }

    const stmt = new Statement(
      native,
      query,
      {
        persistent: true,
        pluck: options.pluck,
        bigint: options.bigint,
      } as Options,
      () => this.#statementCache.delete(cacheKey)
    );
    this.#statementCache.set(cacheKey, stmt as Statement);
    return stmt;
  }

  public close(): void {
    if (this.#native === undefined) {
      throw new Error('Database already closed');
    }
    const native = this.#native;
    for (const statement of [...native.statements]) {
      finalizeNative(statement);
    }
    this.#statementCache.clear();
    this.#transactionStmts = undefined;
    const rc = native.sqlite3.capi.sqlite3_close_v2(native.pDb);
    if (rc !== SQLITE_OK) {
      throw formatSqliteError(native.sqlite3, native.pDb);
    }
    this.#native = undefined;
  }

  public pragma<Options extends PragmaOptions>(
    source: string,
    { simple }: Options
  ): PragmaResult<Options>;

  public pragma(source: string): PragmaResult<object>;

  public pragma<Options extends PragmaOptions = object>(
    source: string,
    { simple }: Options = {} as Options
  ): PragmaResult<Options> {
    if (typeof source !== 'string') {
      throw new TypeError('Invalid pragma argument');
    }
    if (simple === true) {
      const stmt = this.prepare(`PRAGMA ${source}`, { pluck: true });
      return stmt.get() as unknown as PragmaResult<Options>;
    }
    const stmt = this.prepare(`PRAGMA ${source}`);
    return stmt.all() as unknown as PragmaResult<Options>;
  }

  public transaction<Params extends [], Result>(
    fn: (...params: Params) => Result
  ): typeof fn {
    return (...params: Params) => {
      if (this.#transactionStmts === undefined) {
        const options = { persistent: true as const, pluck: true as const };
        this.#transactionStmts = {
          begin: this.prepare('BEGIN', options),
          rollback: this.prepare('ROLLBACK', options),
          commit: this.prepare('COMMIT', options),

          savepoint: this.prepare('SAVEPOINT signalappsqlcipher', options),
          rollbackTo: this.prepare('ROLLBACK TO signalappsqlcipher', options),
          release: this.prepare('RELEASE signalappsqlcipher', options),
        };
      }

      this.#transactionDepth += 1;

      let begin: TransactionStatement;
      let rollback: TransactionStatement;
      let commit: TransactionStatement;
      if (this.#transactionDepth === 1) {
        ({ begin, rollback, commit } = this.#transactionStmts);
      } else {
        ({
          savepoint: begin,
          rollbackTo: rollback,
          release: commit,
        } = this.#transactionStmts);
      }

      begin.run();
      try {
        const result = fn(...params);
        commit.run();
        return result;
      } catch (error) {
        try {
          rollback.run();
        } catch (rollbackError) {
          if (rollbackError instanceof Error) {
            rollbackError.cause = error;
          }
          throw rollbackError;
        }
        throw error;
      } finally {
        this.#transactionDepth -= 1;
      }
    };
  }

  public signalTokenize(value: string): Array<string> {
    if (typeof value !== 'string') {
      throw new TypeError('Invalid value');
    }
    return signalTokenize(textEncoder.encode(value));
  }

  #open(): NativeDatabase {
    if (this.#native === undefined) {
      throw new Error('Database closed');
    }
    return this.#native;
  }
}

function setLogger(fn: (code: string, message: string) => void): void {
  if (typeof fn !== 'function') {
    throw new TypeError('Invalid value');
  }
}

export { Database, setLogger };
