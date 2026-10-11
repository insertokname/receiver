// SPDX-License-Identifier: AGPL-3.0-only
//
// Desktop's full-text search tokenizer, "signal_tokenizer": Signal's own
// Rust implementation (Signal-FTS5-Extension, the revision @signalapp/sqlcipher
// links), compiled to its own small WebAssembly module (sql/tokenizer/) and
// registered with FTS5 through fts5_api, as the addon's initTokenizer() does.
// Search results are therefore the same as in Desktop.

import { WASI } from '@tybys/wasm-util';

import type { Pointer, Sqlite3 } from './sqlite3.d.ts';

type TokenizerExports = {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  tokenize(text: number, len: number, flags: number): number;
  output_ptr(): number;
  output_len(): number;
};

type Token = { flags: number; start: number; end: number; bytes: Uint8Array };

const SQLITE_OK = 0;
const SQLITE_ERROR = 1;
const SQLITE_NOMEM = 7;

let tokenizer: TokenizerExports | undefined;
let input: { ptr: number; capacity: number } | undefined;

export async function loadTokenizer(module: WebAssembly.Module): Promise<void> {
  const wasi = new WASI({ version: 'preview1' });
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  await wasi.initialize(instance);
  tokenizer = instance.exports as unknown as TokenizerExports;
}

// Runs Signal's tokenizer over UTF-8 `text`.
function runTokenizer(text: Uint8Array, flags: number): Array<Token> {
  const t = tokenizer;
  if (!t) {
    throw new Error('signal_tokenizer is not loaded');
  }
  if (!input || input.capacity < text.byteLength) {
    if (input) {
      t.dealloc(input.ptr, input.capacity);
    }
    const capacity = Math.max(1024, text.byteLength);
    input = { ptr: t.alloc(capacity), capacity };
  }
  new Uint8Array(t.memory.buffer, input.ptr, text.byteLength).set(text);
  const rc = t.tokenize(input.ptr, text.byteLength, flags);
  if (rc !== SQLITE_OK) {
    throw new Error(`signal_tokenizer failed: ${rc}`);
  }
  const view = new DataView(t.memory.buffer, t.output_ptr(), t.output_len());
  const tokens = new Array<Token>();
  for (let offset = 0; offset < view.byteLength; ) {
    const tokenFlags = view.getUint32(offset, true);
    const start = view.getUint32(offset + 4, true);
    const end = view.getUint32(offset + 8, true);
    const len = view.getUint32(offset + 12, true);
    offset += 16;
    tokens.push({
      flags: tokenFlags,
      start,
      end,
      bytes: new Uint8Array(view.buffer, view.byteOffset + offset, len).slice(),
    });
    offset += len;
  }
  return tokens;
}

const textDecoder = new TextDecoder();

// Database#signalTokenize: the tokens of a search query (flags 0, as the
// addon calls it).
export function signalTokenize(text: Uint8Array): Array<string> {
  return runTokenizer(text, 0).map(token => textDecoder.decode(token.bytes));
}

// One fts5_tokenizer (xCreate, xDelete, xTokenize) for every connection.
let tokenizerStruct: Pointer | undefined;

function getTokenizerStruct(sqlite3: Sqlite3): Pointer {
  if (tokenizerStruct !== undefined) {
    return tokenizerStruct;
  }
  const { wasm } = sqlite3;

  // int xCreate(void*, const char **azArg, int nArg, Fts5Tokenizer **ppOut)
  const xCreate = wasm.installFunction('i(ppip)', (pCtx, _azArg, _nArg, ppOut) => {
    // The tokenizer has no state: its handle is the module's context.
    wasm.pokePtr(ppOut, pCtx);
    return SQLITE_OK;
  });
  // void xDelete(Fts5Tokenizer*)
  const xDelete = wasm.installFunction('v(p)', () => undefined);
  // int xTokenize(Fts5Tokenizer*, void *pCtx, int flags, const char *pText,
  //               int nText, int (*xToken)(void*, int, const char*, int, int, int))
  const xTokenize = wasm.installFunction(
    'i(ppippp)',
    (_pTokenizer, pCtx, flags, pText, nText, pxToken) => {
      let tokens: Array<Token>;
      try {
        const text = wasm.heap8u().slice(pText, pText + nText);
        tokens = runTokenizer(text, flags);
      } catch {
        return SQLITE_ERROR;
      }
      const xToken = wasm.functionEntry(pxToken);
      if (!xToken) {
        return SQLITE_ERROR;
      }
      const capacity = tokens.reduce((max, t) => Math.max(max, t.bytes.byteLength), 1);
      const buffer = wasm.alloc(capacity);
      if (buffer === 0) {
        return SQLITE_NOMEM;
      }
      try {
        for (const token of tokens) {
          wasm.heap8u().set(token.bytes, buffer);
          const rc = xToken(
            pCtx,
            token.flags,
            buffer,
            token.bytes.byteLength,
            token.start,
            token.end
          );
          if (rc !== SQLITE_OK) {
            return rc;
          }
        }
        return SQLITE_OK;
      } catch {
        return SQLITE_ERROR;
      } finally {
        wasm.dealloc(buffer);
      }
    }
  );

  const struct = wasm.alloc(12);
  wasm.pokePtr(struct, xCreate);
  wasm.pokePtr(struct + 4, xDelete);
  wasm.pokePtr(struct + 8, xTokenize);
  tokenizerStruct = struct;
  return struct;
}

// The addon's Database::InitTokenizer: fetch the connection's fts5_api
// ("SELECT fts5(?1)" with a pointer binding) and create "signal_tokenizer".
export function registerSignalTokenizer(sqlite3: Sqlite3, pDb: Pointer): void {
  const { wasm, capi } = sqlite3;
  const exports = wasm.exports as unknown as {
    sqlite3_step(p: Pointer): number;
    sqlite3_finalize(p: Pointer): number;
  };
  const struct = getTokenizerStruct(sqlite3);
  const stack = wasm.pstack.pointer;
  try {
    const ppApi = wasm.pstack.allocPtr();
    wasm.pokePtr(ppApi, 0);
    const ppStmt = wasm.pstack.allocPtr();
    const [pSql, nSql] = wasm.allocCString('SELECT fts5(?1)', true);
    let rc: number;
    try {
      rc = capi.sqlite3_prepare_v3(pDb, pSql, nSql, 0, ppStmt, 0);
    } finally {
      wasm.dealloc(pSql);
    }
    if (rc !== SQLITE_OK) {
      throw new Error(`signal_tokenizer: ${capi.sqlite3_errmsg(pDb)}`);
    }
    const pStmt = wasm.peekPtr(ppStmt);
    capi.sqlite3_bind_pointer(pStmt, 1, ppApi, 'fts5_api_ptr', 0);
    exports.sqlite3_step(pStmt);
    rc = exports.sqlite3_finalize(pStmt);
    const pApi = wasm.peekPtr(ppApi);
    if (rc !== SQLITE_OK || pApi === 0) {
      throw new Error(`signal_tokenizer: FTS5 is not available (${rc})`);
    }
    // struct fts5_api { int iVersion; xCreateTokenizer; ... }
    const xCreateTokenizer = wasm.functionEntry(wasm.peekPtr(pApi + 4));
    if (!xCreateTokenizer) {
      throw new Error('signal_tokenizer: fts5_api.xCreateTokenizer is missing');
    }
    const pName = wasm.allocCString('signal_tokenizer');
    try {
      rc = xCreateTokenizer(pApi, pName, struct, struct, 0);
    } finally {
      wasm.dealloc(pName);
    }
    if (rc !== SQLITE_OK) {
      throw new Error(`signal_tokenizer: xCreateTokenizer failed: ${capi.sqlite3_js_rc_str(rc) ?? rc}`);
    }
  } finally {
    wasm.pstack.restore(stack);
  }
}
