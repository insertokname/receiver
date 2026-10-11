// SPDX-License-Identifier: AGPL-3.0-only
// Types for modules the SQL worker build resolves itself (renderer/build.mjs).

declare module 'sqlite3mc' {
  // sqlite3InitModule; typed in sqlite3.d.ts (Sqlite3InitModule).
  const sqlite3InitModule: unknown;
  export default sqlite3InitModule;
}

declare module 'virtual:web-sql-assets' {
  type WasmAsset = Readonly<{ path: string; integrity: string }>;

  const assets: { sqlite: WasmAsset; tokenizer: WasmAsset; libsignal: WasmAsset };
  export default assets;
}
