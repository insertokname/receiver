// SPDX-License-Identifier: AGPL-3.0-only
//
// The parts of SQLite's JavaScript/WebAssembly API (sqlite3.mjs from
// SQLite3 Multiple Ciphers' WASM distribution) the SQL worker uses.
// Pointers are numbers (wasm32).

export type Pointer = number;

export type SahPoolUtil = {
  vfsName: string;
  getFileNames(): Array<string>;
  exportFile(name: string): Uint8Array;
  unlink(name: string): boolean;
  pauseVfs(): SahPoolUtil;
  unpauseVfs(): Promise<SahPoolUtil>;
  isPaused(): boolean;
  getCapacity(): number;
  addCapacity(n: number): Promise<number>;
};

export type Sqlite3Wasm = {
  exports: Record<string, (...args: Array<number | bigint>) => number | bigint>;
  heap8u(): Uint8Array;
  alloc(n: number): Pointer;
  dealloc(p: Pointer): void;
  allocCString(s: string, withLength: true): [Pointer, number];
  allocCString(s: string): Pointer;
  cstrToJs(p: Pointer): string | null;
  peekPtr(p: Pointer): Pointer;
  pokePtr(p: Pointer, value: Pointer): void;
  peek32(p: Pointer): number;
  functionEntry(p: Pointer): ((...args: Array<number>) => number) | undefined;
  installFunction(sig: string, fn: (...args: Array<number>) => number | void): Pointer;
  pstack: {
    pointer: Pointer;
    restore(p: Pointer): void;
    allocPtr(): Pointer;
  };
};

export type Sqlite3Capi = {
  SQLITE_WASM_DEALLOC: number;
  sqlite3_open_v2(filename: string, ppDb: Pointer, flags: number, vfs: string | null): number;
  sqlite3_close_v2(pDb: Pointer): number;
  sqlite3_extended_result_codes(pDb: Pointer, onoff: number): number;
  sqlite3_exec(pDb: Pointer, sql: string, cb: 0, arg: 0, errmsg: 0): number;
  sqlite3_errmsg(pDb: Pointer): string;
  sqlite3_errstr(rc: number): string;
  sqlite3_error_offset(pDb: Pointer): number;
  sqlite3_extended_errcode(pDb: Pointer): number;
  sqlite3_js_rc_str(rc: number): string | undefined;
  sqlite3_prepare_v3(
    pDb: Pointer,
    sql: Pointer,
    nSql: number,
    flags: number,
    ppStmt: Pointer,
    pzTail: Pointer
  ): number;
  sqlite3_bind_parameter_name(pStmt: Pointer, i: number): string | null;
  sqlite3_column_name(pStmt: Pointer, i: number): string;
  sqlite3_create_function_v2(
    pDb: Pointer,
    name: string,
    nArg: number,
    eTextRep: number,
    pApp: 0,
    xFunc: (pCtx: Pointer, ...args: Array<unknown>) => unknown,
    xStep: 0,
    xFinal: 0,
    xDestroy: 0
  ): number;
  sqlite3_bind_pointer(pStmt: Pointer, i: number, p: Pointer, type: string, xDestroy: 0): number;
  sqlite3_compileoption_used(name: string): number;
  sqlite3mc_vfs_create(baseVfs: string, makeDefault: number): number;
  sqlite3mc_version(): string;
  sqlite3_libversion(): string;
};

export type Sqlite3 = {
  capi: Sqlite3Capi;
  wasm: Sqlite3Wasm;
  installOpfsSAHPoolVfs(options: {
    name: string;
    directory: string;
    initialCapacity?: number;
    clearOnInit?: boolean;
    verbosity?: number;
  }): Promise<SahPoolUtil>;
};

export type Sqlite3InitModule = (options: {
  print: (...args: Array<unknown>) => void;
  printErr: (...args: Array<unknown>) => void;
  instantiateWasm: (
    imports: WebAssembly.Imports,
    onSuccess: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
  ) => Promise<unknown> | object;
}) => Promise<Sqlite3>;
