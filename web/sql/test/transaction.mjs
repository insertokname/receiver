// SPDX-License-Identifier: AGPL-3.0-only
//
// Database.transaction() of the SQL wrapper (sql/sqlcipher.ts) on the built
// SQLite WASM (sql/dist), in memory:
//   - an error thrown inside rolls the transaction back and is rethrown;
//   - storage full (SQLITE_FULL, here via max_page_count) surfaces as
//     SQLITE_FULL, at the top level and from a nested transaction (SQLite
//     has already rolled back; a ROLLBACK then fails "no transaction is
//     active", which hid the error and the shell's storage-full screen);
//   - the database takes new transactions afterwards.
// Run: node sql/test/transaction.mjs (after sql/build.sh)

import { readFile } from 'node:fs/promises';

import Database, { setEngine } from '../sqlcipher.ts';

const DIST = new URL('../dist/sqlite3mc/', import.meta.url);
const { default: sqlite3InitModule } = await import(new URL('sqlite3.mjs', DIST).href);
const module = await WebAssembly.compile(await readFile(new URL('sqlite3.wasm', DIST)));

// The OPFS VFSes can't install in Node; it says so on console.warn.
const { warn } = console;
console.warn = () => undefined;
const sqlite3 = await sqlite3InitModule({
  print: () => undefined,
  printErr: () => undefined,
  instantiateWasm(imports, onSuccess) {
    WebAssembly.instantiate(module, imports).then(instance => onSuccess(instance, module));
    return {};
  },
});
console.warn = warn;
setEngine(sqlite3, 'unused');

let checks = 0;
function check(ok, what) {
  checks += 1;
  if (!ok) throw new Error(`TRANSACTION FAIL: ${what}`);
}
function thrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const db = new Database(':memory:');
db.exec('CREATE TABLE t (v TEXT)');
const insert = db.prepare('INSERT INTO t (v) VALUES ($v)');
const count = () => db.prepare('SELECT count(*) FROM t', { pluck: true }).get();
const fill = () => {
  for (let i = 0; i < 1000; i += 1) insert.run({ v: 'x'.repeat(2000) });
};

const failure = new Error('inside');
const error = thrown(db.transaction(() => {
  insert.run({ v: 'kept out' });
  throw failure;
}));
check(error === failure, `error from inside rethrown: ${error}`);
check(count() === 0, 'rolled back');

db.exec(`PRAGMA max_page_count = ${db.pragma('page_count', { simple: true }) + 10}`);
const full = thrown(db.transaction(fill));
check(/SQLITE_FULL/.test(full?.message), `top level: ${full?.message} (cause: ${full?.cause?.message})`);

const nested = thrown(db.transaction(() => {
  insert.run({ v: 'outer' });
  db.transaction(fill)();
}));
check(/SQLITE_FULL/.test(nested?.message), `nested: ${nested?.message} (cause: ${nested?.cause?.message})`);
check(count() === 0, `nothing kept after storage full: ${count()} rows`);

db.exec('PRAGMA max_page_count = 1073741823');
db.transaction(() => insert.run({ v: 'after' }))();
check(count() === 1, 'a new transaction commits afterwards');
db.close();

console.log(`TRANSACTION PASS (${checks} checks)`);
