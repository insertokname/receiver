// SPDX-License-Identifier: AGPL-3.0-only
//
// Storage test in headless Chromium, on the built site (web/dist/site) at
// the deployment's path (http://pages.example:8080/receiver/, the app's):
//
//   (a) first start creates the database and runs all of Desktop's
//       migrations (schema version, timings)
//   (b) after a reload the database opens with the same key; an item
//       written through Desktop's SQL code (createOrUpdateItem) is still
//       there; full-text search (signal_tokenizer) works
//   (c) the files in the origin private file system are encrypted: no
//       SQLite header, none of the plaintext written
//   (d) a second tab gets "in use" and the first one keeps working
//   (e) remove-db + erase-sql-key delete the database and the stored key;
//       the next start creates a new database
//   (f) a database without its key fails to open with a clear error, and
//       remove-db still deletes it
//
// The test page (sql/test/page.ts, bundled here) is served by this runner
// only: it is not part of the site, since (e) deletes the database.
//
//   node sql/test/run.mjs

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

import { webResolvePlugin } from '../../renderer/resolve.mjs';
import { BASE_PATH, LOCAL_ORIGIN, SITE_DIR, launchBrowser, serveSite, watchPage } from '../../scripts/harness.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = join(HERE, '../..');
const REPO = join(WEB, '..');

const MARKER = `receiver-plaintext-marker-${Math.random().toString(36).slice(2)}`;
const BODY_MARKER = 'Zanzibarquokka';
const SECRET_PATTERNS = [/\b[0-9a-f]{64}\b/i, /PRAGMA key/i];

// The test page: same CSP as the app (read from the built page).
const appHtml = await readFile(join(SITE_DIR, 'index.html'), 'utf8');
const csp = appHtml.match(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/)?.[0];
if (!csp) throw new Error('index.html has no CSP meta tag');

const resolver = webResolvePlugin();
const bundle = await build({
  cwd: REPO,
  input: join(HERE, 'page.ts'),
  platform: 'browser',
  tsconfig: join(REPO, 'tsconfig.json'),
  write: false,
  transform: {
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
    inject: { process: 'node:process', Buffer: ['node:buffer', 'Buffer'] },
  },
  plugins: [resolver.plugin],
  output: { format: 'esm', codeSplitting: false },
});
const pageJs = bundle.output[0].code;

const rawJs = `
window.readOpfs = async () => {
  const out = [];
  const toBase64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  async function walk(dir, path) {
    for await (const [name, handle] of dir) {
      if (handle.kind === 'directory') await walk(handle, path + name + '/');
      else out.push({ path: path + name, data: toBase64(new Uint8Array(await (await handle.getFile()).arrayBuffer())) });
    }
  }
  await walk(await navigator.storage.getDirectory(), '/');
  return out;
};
window.deleteKeyStore = () => new Promise((resolve, reject) => {
  const req = indexedDB.deleteDatabase('receiver-sql-key');
  req.onsuccess = () => resolve(true);
  req.onerror = () => reject(req.error);
  req.onblocked = () => reject(new Error('blocked'));
});
window.readKeyStore = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('receiver-sql-key');
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('keys')) { db.close(); resolve({ records: 0 }); return; }
    const all = db.transaction('keys').objectStore('keys').getAll();
    all.onsuccess = () => {
      db.close();
      resolve({ records: all.result.length, keys: all.result.map(r => ({ extractable: r.wrappingKey.extractable, algorithm: r.wrappingKey.algorithm.name, usages: r.wrappingKey.usages, wrappedBytes: r.wrapped.byteLength })) });
    };
    all.onerror = () => reject(all.error);
  };
});
`;

const app = BASE_PATH;
const server = await serveSite({
  extra: {
    [`${app}storage-test.html`]: [
      'text/html; charset=utf-8',
      `<!doctype html><html><head><meta charset="utf-8">${csp}<title>storage test</title><script type="module" src="./storage-test.js"></script></head><body></body></html>`,
    ],
    [`${app}storage-test.js`]: ['text/javascript', pageJs],
    [`${app}storage-raw.html`]: [
      'text/html; charset=utf-8',
      '<!doctype html><html><head><meta charset="utf-8"><title>raw</title><script src="./storage-raw.js"></script></head><body></body></html>',
    ],
    [`${app}storage-raw.js`]: ['text/javascript', rawJs],
  },
});
const browser = await launchBrowser();
const problems = [];
const logLines = [];
const results = {};

function check(condition, message) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) problems.push(message);
}

async function openTestPage(name) {
  const page = await browser.newPage();
  const watcher = await watchPage(page);
  page.on('console', m => {
    const text = m.text();
    logLines.push(text);
    if (!/\[updateSchema\(\d+\)\] success$/.test(text)) console.log(`  [${name}] | ${text.slice(0, 300)}`);
  });
  page.on('pageerror', e => problems.push(`[${name}] uncaught exception: ${e.message}`));
  await page.goto(`${LOCAL_ORIGIN}${app}storage-test.html`);
  await page.waitForFunction(() => window.storageTest);
  return { page, watcher };
}

async function ready(page) {
  const started = Date.now();
  await page.evaluate(() => window.storageTest.ready);
  const storage = await page.evaluate(() => window.__webStorage);
  return { ...storage, waitedMs: Date.now() - started };
}

const invoke = (page, channel, ...args) =>
  page.evaluate(
    (c, a) =>
      window.storageTest
        .invoke(c, ...a)
        .then(r =>
          r && r.ok === false
            ? { ok: false, error: { name: r.error.name, message: r.error.message } }
            : JSON.parse(JSON.stringify(r ?? null))
        ),
    channel,
    args
  );

async function readRaw({ deleteKey = false } = {}) {
  const page = await browser.newPage();
  await page.goto(`${LOCAL_ORIGIN}${app}storage-raw.html`);
  if (deleteKey) await page.evaluate(() => window.deleteKeyStore());
  const files = (await page.evaluate(() => window.readOpfs())).map(f => ({ path: f.path, data: Buffer.from(f.data, 'base64') }));
  const keyStore = await page.evaluate(() => window.readKeyStore());
  await page.close();
  return { files, keyStore };
}

// opfs-sahpool keeps each file in a slot: a 4096-byte header with the path,
// then the data.
const slotPath = data => data.subarray(0, 512).toString('utf8').replace(/\0.*$/s, '');

const conversationId = crypto.randomUUID();
const ourAci = crypto.randomUUID();
const now = Date.now();
const messages = [
  { body: `hello ${BODY_MARKER} café`, sent: now - 30 },
  { body: 'see https://www.example.org/some/path?x=1 for details', sent: now - 20 },
  { body: '我们知识 안녕 세상', sent: now - 10 },
].map(({ body, sent }) => ({
  id: crypto.randomUUID(),
  body,
  type: 'outgoing',
  conversationId,
  sent_at: sent,
  received_at: sent,
  timestamp: sent,
}));

async function search(page, query) {
  const r = await invoke(page, 'sql-channel:read', 'searchMessages', [{ query, filterByUnread: false }]);
  if (!r.ok) throw new Error(`searchMessages(${query}) failed: ${r.error?.message}`);
  return r.value.map(m => messages.findIndex(x => x.id === m.id)).sort();
}

let ok = false;
try {
  console.log(`storage test: ${LOCAL_ORIGIN}${app}`);

  console.log('(a) first start');
  let { page, watcher } = await openTestPage('tab 1');
  let storage = await ready(page);
  results.firstStart = storage;
  console.log(`  ${JSON.stringify(storage)}`);
  check(storage.info?.created === true, 'database created');
  check(storage.info?.schemaVersion >= 1830, `all migrations ran (schema version ${storage.info?.schemaVersion})`);
  // Asked once the app is linked (web/shell/storage.ts), never when the
  // database is created (Firefox would prompt on the first visit).
  check(!('persisted' in storage), 'navigator.storage.persist() not asked when the database is created');

  let r = await invoke(page, 'sql-channel:write', 'createOrUpdateItem', [{ id: 'webStorageTest', value: MARKER }]);
  check(r.ok, `createOrUpdateItem ${r.ok ? '' : r.error?.message}`);
  r = await invoke(page, 'sql-channel:write', 'saveMessages', [messages, { forceSave: true, ourAci }]);
  check(r.ok, `saveMessages (3 messages) ${r.ok ? '' : r.error?.message}`);
  check(JSON.stringify(await search(page, BODY_MARKER.toLowerCase())) === '[0]', 'search: word, case-insensitive');
  check(JSON.stringify(await search(page, 'cafe')) === '[0]', 'search: diacritics removed (café = cafe)');
  check(JSON.stringify(await search(page, 'example.org')) === '[1]', 'search: URL host');
  check(JSON.stringify(await search(page, '知')) === '[2]', 'search: CJK character');
  check(JSON.stringify(await search(page, '세상')) === '[2]', 'search: Hangul word');

  console.log('(b) reload');
  await page.reload();
  await page.waitForFunction(() => window.storageTest);
  storage = await ready(page);
  results.reload = storage;
  console.log(`  ${JSON.stringify(storage)}`);
  check(storage.info?.created === false, 'database reopened (not created again)');
  r = await invoke(page, 'sql-channel:read', 'getItemById', ['webStorageTest']);
  check(r.ok && r.value?.value === MARKER, 'item written before the reload is read back');
  check(JSON.stringify(await search(page, BODY_MARKER)) === '[0]', 'search after reload');

  console.log('(d) second tab');
  const second = await openTestPage('tab 2');
  const started = Date.now();
  const secondError = await second.page.evaluate(() => window.storageTest.ready.then(() => window.__webStorage?.error ?? null));
  results.secondTab = { error: secondError, ms: Date.now() - started };
  console.log(`  second tab: ${secondError} (${Date.now() - started} ms)`);
  check(/DatabaseInUseError/.test(secondError ?? ''), 'second tab: "in use" error');
  r = await invoke(second.page, 'sql-channel:read', 'getItemById', ['webStorageTest']);
  check(!r.ok && /in use by another tab/.test(r.error?.message ?? ''), `second tab: SQL calls fail with that error (${r.error?.message?.slice(0, 80)})`);
  r = await invoke(page, 'sql-channel:write', 'createOrUpdateItem', [{ id: 'webStorageTest2', value: 'still-working' }]);
  const r2 = await invoke(page, 'sql-channel:read', 'getItemById', ['webStorageTest2']);
  check(r.ok && r2.ok && r2.value?.value === 'still-working', 'first tab keeps working');
  // A delete runs Desktop's checkpoint trigger (a SQL function) and the
  // checkpoint request from the page.
  r = await invoke(page, 'sql-channel:write', 'removeItemById', ['webStorageTest2']);
  await new Promise(resolve => setTimeout(resolve, 500));
  check(r.ok && !logLines.some(l => /WalCheckpoints.run: Unexpected error|checkpoint failed/.test(l)), 'delete + WAL checkpoint');
  problems.push(...(await second.watcher.report()));
  await second.page.close();

  problems.push(...(await watcher.report()));
  await page.close();

  console.log('(c) files at rest');
  let raw = await readRaw();
  const marker = Buffer.from(MARKER);
  const bodyMarker = Buffer.from(BODY_MARKER);
  const header = Buffer.from('SQLite format 3');
  for (const f of raw.files) {
    console.log(`  ${f.path} ${f.data.length} bytes ${slotPath(f.data) || '(free slot)'}`);
  }
  const dbSlot = raw.files.find(f => slotPath(f.data) === '/userData/sql/db.sqlite');
  results.files = raw.files.map(f => ({ path: f.path, bytes: f.data.length, slot: slotPath(f.data) }));
  check(dbSlot && dbSlot.data.length > 100_000, `database file found (${dbSlot?.data.length} bytes)`);
  check(raw.files.every(f => f.data.indexOf(header) === -1), 'no file has the SQLite header');
  check(raw.files.every(f => f.data.indexOf(marker) === -1), 'no file contains the item value');
  check(raw.files.every(f => f.data.indexOf(bodyMarker) === -1 && f.data.indexOf(Buffer.from('example.org')) === -1), 'no file contains message text');
  results.keyStore = raw.keyStore;
  console.log(`  key store: ${JSON.stringify(raw.keyStore)}`);
  check(raw.keyStore.records === 1 && raw.keyStore.keys[0].extractable === false, 'one stored key, wrapping key not extractable');

  console.log('(e) remove-db and erase-sql-key');
  ({ page, watcher } = await openTestPage('tab 3'));
  storage = await ready(page);
  check(storage.info?.created === false, 'database opens again');
  r = await invoke(page, 'sql-channel:remove-db');
  check(r === null, 'remove-db');
  r = await invoke(page, 'erase-sql-key');
  check(r === null, 'erase-sql-key');
  problems.push(...(await watcher.report()));
  await page.close();
  raw = await readRaw();
  check(!raw.files.some(f => slotPath(f.data).startsWith('/userData/sql/db.sqlite')), 'database files deleted');
  check(raw.keyStore.records === 0, 'stored key deleted');
  ({ page, watcher } = await openTestPage('tab 4'));
  storage = await ready(page);
  check(storage.info?.created === true, 'next start creates a new database');
  r = await invoke(page, 'sql-channel:read', 'getItemById', ['webStorageTest']);
  check(r.ok && r.value == null, 'old data is gone');
  problems.push(...(await watcher.report()));
  await page.close();

  console.log('(f) key missing');
  raw = await readRaw({ deleteKey: true });
  check(raw.keyStore.records === 0 && raw.files.some(f => slotPath(f.data) === '/userData/sql/db.sqlite'), 'key deleted, database still there');
  ({ page, watcher } = await openTestPage('tab 5'));
  storage = await ready(page);
  results.keyMissing = storage.error;
  console.log(`  ${storage.error}`);
  check(/DatabaseKeyError/.test(storage.error ?? ''), 'clear "key missing" error');
  r = await invoke(page, 'sql-channel:read', 'getItemById', ['webStorageTest']);
  check(!r.ok && /key is missing/.test(r.error?.message ?? ''), 'SQL calls fail with that error');
  r = await invoke(page, 'sql-channel:remove-db');
  check(r === null, 'remove-db works without the key');
  problems.push(...(await watcher.report()));
  await page.close();
  raw = await readRaw();
  check(!raw.files.some(f => slotPath(f.data).startsWith('/userData/sql/db.sqlite')), 'database files deleted');
  ({ page, watcher } = await openTestPage('tab 6'));
  storage = await ready(page);
  check(storage.info?.created === true, 'next start creates a new database');
  problems.push(...(await watcher.report()));
  await page.close();

  const secrets = logLines.filter(l => SECRET_PATTERNS.some(p => p.test(l)) || l.includes(MARKER) || l.includes(BODY_MARKER));
  check(secrets.length === 0, `no key, item value or message text in ${logLines.length} log lines`);

  console.log(`results: ${JSON.stringify(results)}`);
  for (const p of problems) console.log(`STORAGE FAIL: ${p}`);
  ok = problems.length === 0;
  console.log(ok ? 'STORAGE PASS' : 'STORAGE FAIL');
} catch (e) {
  console.log(`STORAGE FAIL: ${e.stack ?? e.message}`);
} finally {
  await browser.close();
  server.close();
}
process.exit(ok ? 0 : 1);
