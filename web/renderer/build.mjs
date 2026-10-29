// SPDX-License-Identifier: AGPL-3.0-only
//
// Builds Desktop's main window for the browser into OUT_DIR (default
// web/dist/app/, deployed at the site's root, /receiver/):
//
//   index.html            from background.html, strict CSP, Subresource Integrity
//                         for its scripts, stylesheets and modules (import map)
//   app.js, chunks/       the renderer bundle (entry.ts -> preload graph)
//   transport/webtor_wasm_bg.wasm   the Tor transport (web/transport), for web/net
//   transport/timer-worker.js       its timer worker (kept on time in a hidden page)
//                         (the Tor directory snapshot is the site's transport/tor/)
//   libsignal_node.wasm   next to libsignal's loader (in app.js)
//   stylesheets/          Desktop's compiled SCSS + Tailwind (asset:/// -> ../)
//   fonts/ images/ sounds/
//   locales/              compact locale messages + display names
//   sql/worker.js         the SQL worker (web/sql/: Desktop's
//                         ts/sql/Server.node.ts on SQLite3 Multiple Ciphers)
//   sql/sqlite3.wasm, sql/signal_tokenizer.wasm
//
// Expects Desktop's generated sources (protobuf, emoji data, styles, compact
// locales) and web/sql/dist/; renderer/build.sh runs those generators and
// sql/build.sh first.
//
// Usage: node renderer/build.mjs [--out DIR] [--no-minify] [--report FILE] [--e2e]
//
// --e2e builds the end-to-end test variant into web/dist/app-e2e/ (never
// deployed): config pointing at Desktop's mock server (web/e2e/config.mjs),
// the transport's test-relay build (transport/build.sh --test-relay) and
// web/e2e/relay-carrier.ts in place of web/net/carrier.ts (Tor), with a CSP
// that allows the local relay. The production build checks that none of
// that is in its output.

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'rolldown';

import { addIntegrity } from '../scripts/sri.mjs';
import { buildServiceWorker } from '../sw/build.mjs';
import { netAssetsPlugin, transportTimerWorker, transportWasm } from './net-assets.mjs';
import { webResolvePlugin, LIBSIGNAL_PACKAGE } from './resolve.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = join(HERE, '..');
const REPO = join(WEB, '..');

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    'no-minify': { type: 'boolean', default: false },
    report: { type: 'string' },
    e2e: { type: 'boolean', default: false },
  },
});
const E2E = args.e2e;
const OUT = args.out ?? join(WEB, E2E ? 'dist/app-e2e' : 'dist/app');
const minify = !args['no-minify'];

const readJson = async path => JSON.parse(await readFile(join(REPO, path), 'utf8'));

for (const generated of [
  'ts/protobuf/compiled.std.js',
  'build/emoji-data.json',
  'stylesheets/manifest.css',
  'stylesheets/tailwind.css',
  'stylesheets/quill.css',
  'build/compact-locales/keys.json',
  'web/sql/dist/sqlite3mc/sqlite3.mjs',
  'web/sql/dist/sqlite3mc/sqlite3.wasm',
  'web/sql/dist/signal_tokenizer.wasm',
]) {
  if (!existsSync(join(REPO, generated))) {
    throw new Error(`${generated} is missing: run renderer/build.sh (Desktop's generators, sql/build.sh)`);
  }
}

// Static renderer config: what Electron's main process derives from
// config/default.json + config/production.json and package.json. Values that
// depend on the browser (locale, theme, ...) are added at runtime by
// web/main/config.ts, and the result is validated with Desktop's own schema.
async function staticConfig() {
  const merged = { ...(await readJson('config/default.json')), ...(await readJson('config/production.json')) };
  merged.cdn = { ...(await readJson('config/default.json')).cdn, ...(await readJson('config/production.json')).cdn };
  const packageJson = await readJson('package.json');
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  const buildCreation =
    1000 * Number(sourceDateEpoch ?? execSync('git show -s --format=%ct', { cwd: REPO }).toString().trim());
  return {
    name: 'receiver',
    version: packageJson.version,
    environment: 'production',
    buildCreation,
    // As a packaged Desktop build: 90 days after the commit it was built
    // from (ts/util/buildExpiration.std.ts). Derived from the commit, not
    // the build time, so that the daily redeployment builds the same files
    // and the service worker does not offer an "update" every day.
    buildExpiration: buildCreation + 90 * 24 * 3600 * 1000,
    serverUrl: merged.serverUrl,
    storageUrl: merged.storageUrl,
    updatesUrl: merged.updatesUrl,
    resourcesUrl: merged.resourcesUrl,
    cdnUrl0: merged.cdn['0'],
    cdnUrl2: merged.cdn['2'],
    cdnUrl3: merged.cdn['3'],
    certificateAuthority: merged.certificateAuthority,
    contentProxyUrl: merged.contentProxyUrl,
    challengeUrl: merged.challengeUrl,
    registrationChallengeUrl: merged.registrationChallengeUrl,
    sfuUrl: merged.sfuUrl,
    serverPublicParams: merged.serverPublicParams,
    serverTrustRoots: merged.serverTrustRoots,
    genericServerPublicParams: merged.genericServerPublicParams,
    backupServerPublicParams: merged.backupServerPublicParams,
    stripePublishableKey: merged.stripePublishableKey,
    ciMode: merged.ciMode,
    ciForceUnprocessed: merged.ciForceUnprocessed,
    devTools: false,
    dnsFallback: await readJson('build/dns-fallback.json'),
  };
}

// The end-to-end test variant: Desktop's mock server instead of Signal,
// reached through the local test relay.
const e2e = E2E ? await import('../e2e/config.mjs') : undefined;
const TRANSPORT_DIR = join(WEB, E2E ? 'transport/dist-e2e' : 'transport/dist');
const config = { ...(await staticConfig()), ...e2e?.mockServerConfig() };
const E2E_CONFIG_ID = '\0web-e2e-config';
const e2ePlugin = {
  name: 'web-e2e',
  resolveId(source, importer) {
    if (source === 'virtual:web-e2e-config') return E2E_CONFIG_ID;
    if (!importer || !source.startsWith('.') || importer.startsWith('\0')) return null;
    const target = resolvePath(dirname(importer), source);
    if (target === join(WEB, 'net/carrier.ts')) return join(WEB, 'e2e/relay-carrier.ts');
    const prodTransport = join(WEB, 'transport/dist') + '/';
    if (target.startsWith(prodTransport)) return join(TRANSPORT_DIR, target.slice(prodTransport.length));
    return null;
  },
  load: id => (id === E2E_CONFIG_ID ? `export default ${JSON.stringify({ relayUrl: e2e.RELAY_URL })};` : null),
};
const STATIC_CONFIG_ID = '\0web-static-config';

// The network layer (web/net): the transport's WebAssembly, fetched by the
// page from app/transport/ and checked against its digest.
const netAssets = await netAssetsPlugin({ transportDir: TRANSPORT_DIR });

const resolver = webResolvePlugin();
const problems = [];
const started = Date.now();

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// Shared by the page bundle and the SQL worker bundle.
const transform = {
  jsx: 'react-jsx',
  define: {
    'process.env.IS_BUNDLED': 'true',
    'process.env.NODE_ENV': '"production"',
    global: 'globalThis',
  },
  inject: {
    process: 'node:process',
    Buffer: ['node:buffer', 'Buffer'],
    setImmediate: ['node:timers', 'setImmediate'],
    clearImmediate: ['node:timers', 'clearImmediate'],
  },
};
function onLog(level, log) {
  // Every import must resolve: to a dependency, a web sibling or a shim.
  if (['UNRESOLVED_IMPORT', 'MISSING_EXPORT', 'IMPORT_IS_UNDEFINED'].includes(log.code)) {
    problems.push(log.message);
    return;
  }
  if (log.code === 'EVAL' || log.code === 'CIRCULAR_DEPENDENCY') {
    return;
  }
  if (level === 'warn') {
    console.warn(`warning: ${log.code}: ${log.message.split('\n')[0]}`);
  }
}
const output = {
  format: 'esm',
  entryFileNames: '[name].js',
  chunkFileNames: 'chunks/[name]-[hash].js',
  minify,
  sourcemap: false,
  generatedCode: { symbols: false },
  comments: { legal: false },
};

// Where the page bundle puts libsignal's WebAssembly: next to its loader,
// which is in app.js (checked after the page bundle).
const LIBSIGNAL_WASM_TARGET = join(OUT, 'libsignal_node.wasm');

// The SQL worker: its own bundle with its own fs, worker_threads and
// @signalapp/sqlcipher (web/sql/), one file (the page checks its digest
// before starting it; a worker's imports cannot carry integrity). It fetches
// its WebAssembly modules (relative to itself) and checks them against these
// digests. Built before the page, which needs the worker's digest.
const SQL_DIST = join(WEB, 'sql/dist');
const SQL_OUT = join(OUT, 'sql');
const SQL_ASSETS_ID = '\0web-sql-assets';
const sri = async path => `sha384-${createHash('sha384').update(await readFile(path)).digest('base64')}`;
const sqlAssets = {
  sqlite: { path: 'sqlite3.wasm', integrity: await sri(join(SQL_DIST, 'sqlite3mc/sqlite3.wasm')) },
  tokenizer: { path: 'signal_tokenizer.wasm', integrity: await sri(join(SQL_DIST, 'signal_tokenizer.wasm')) },
  // The page's copy (same URL, so the browser cache serves it).
  libsignal: {
    path: relative(SQL_OUT, LIBSIGNAL_WASM_TARGET),
    integrity: await sri(join(LIBSIGNAL_PACKAGE, 'wasm/libsignal_node.wasm')),
  },
};
const sqlResolver = webResolvePlugin({
  overrides: {
    fs: ['partial', join(WEB, 'sql/shims/fs.ts')],
    'fs/promises': ['unavailable'],
    worker_threads: ['shim', join(WEB, 'sql/shims/worker-threads.ts')],
    '@signalapp/sqlcipher': ['real', join(WEB, 'sql/sqlcipher.ts')],
    sqlite3mc: ['real', join(SQL_DIST, 'sqlite3mc/sqlite3.mjs')],
  },
});
await mkdir(SQL_OUT, { recursive: true });
const sqlBundle = await build({
  cwd: REPO,
  input: { worker: join(WEB, 'sql/worker.ts') },
  platform: 'browser',
  tsconfig: join(REPO, 'tsconfig.json'),
  transform,
  plugins: [
    sqlResolver.plugin,
    {
      name: 'web-sql-assets',
      resolveId: id => (id === 'virtual:web-sql-assets' ? SQL_ASSETS_ID : null),
      load: id => (id === SQL_ASSETS_ID ? `export default ${JSON.stringify(sqlAssets)};` : null),
    },
  ],
  onLog,
  output: { ...output, dir: SQL_OUT, codeSplitting: false },
});
if (sqlBundle.output.filter(o => o.type === 'chunk').length !== 1) throw new Error('the SQL worker must be one file');
await cp(join(SQL_DIST, 'sqlite3mc/sqlite3.wasm'), join(SQL_OUT, 'sqlite3.wasm'));
await cp(join(SQL_DIST, 'signal_tokenizer.wasm'), join(SQL_OUT, 'signal_tokenizer.wasm'));
if (problems.length) {
  for (const p of problems) console.error(`error: ${p.split('\n')[0]}`);
  throw new Error(`${problems.length} unresolved imports or missing exports`);
}

// What the page itself fetches from the site besides modules, with SHA-384
// digests it checks (fetch integrity): the SQL worker, before starting it,
// and the locale files. WebAssembly digests are in web/net (transport) and
// libsignal's loader.
const localeFiles = {};
for (const entry of readdirSync(join(REPO, 'build/compact-locales'), { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = join(entry.parentPath, entry.name);
  localeFiles[relative(join(REPO, 'build/compact-locales'), path).split(sep).join('/')] = await sri(path);
}
for (const name of ['available-locales.json', 'locale-display-names.json', 'country-display-names.json']) {
  localeFiles[name] = await sri(join(REPO, 'build', name));
}
const localAssets = {
  sqlWorker: { path: 'sql/worker.js', integrity: await sri(join(SQL_OUT, 'worker.js')) },
  locales: Object.fromEntries(Object.entries(localeFiles).sort(([a], [b]) => (a < b ? -1 : 1))),
};
const LOCAL_ASSETS_ID = '\0web-local-assets';


const bundle = await build({
  cwd: REPO,
  input: { app: join(HERE, 'entry.ts') },
  platform: 'browser',
  tsconfig: join(REPO, 'tsconfig.json'),
  transform,
  plugins: [
    ...(E2E ? [e2ePlugin] : []),
    resolver.plugin,
    {
      name: 'web-static-config',
      resolveId: id => (id === 'virtual:web-static-config' ? STATIC_CONFIG_ID : null),
      load: id => (id === STATIC_CONFIG_ID ? `export default ${JSON.stringify(config)};` : null),
    },
    netAssets.plugin,
    {
      name: 'web-local-assets',
      resolveId: id => (id === 'virtual:web-local-assets' ? LOCAL_ASSETS_ID : null),
      load: id => (id === LOCAL_ASSETS_ID ? `export default ${JSON.stringify(localAssets)};` : null),
    },
  ],
  onLog,
  output: { ...output, dir: OUT },
});

if (problems.length) {
  for (const p of problems) console.error(`error: ${p.split('\n')[0]}`);
  throw new Error(`${problems.length} unresolved imports or missing exports`);
}

// libsignal's loader fetches the module next to itself.
const loaderChunk = bundle.output.find(
  o => o.type === 'chunk' && o.moduleIds.some(id => id.startsWith(join(LIBSIGNAL_PACKAGE, 'wasm/')))
);
if (!loaderChunk) throw new Error('libsignal loader not found in the bundle');
const wasmTarget = join(OUT, loaderChunk.fileName, '..', 'libsignal_node.wasm');
if (wasmTarget !== LIBSIGNAL_WASM_TARGET) throw new Error(`libsignal's loader moved: ${loaderChunk.fileName}`);
await cp(join(LIBSIGNAL_PACKAGE, 'wasm/libsignal_node.wasm'), wasmTarget);

await mkdir(join(OUT, 'transport'));
await cp(transportWasm(TRANSPORT_DIR), join(OUT, netAssets.assets.transport.wasmUrl));
await cp(transportTimerWorker(TRANSPORT_DIR), join(OUT, netAssets.assets.transport.timerWorker.url));

// The voice note recorder's MP3 encoder: an AudioWorklet module that
// ts/services/audioRecorder.dom.ts loads from bundles/workers/mp3Encoder.js
// (as rolldown.config.ts builds it for Desktop). LAME is compiled to plain
// JavaScript (packages/lame), so the worklet needs no WebAssembly.
await build({
  cwd: REPO,
  input: join(REPO, 'ts/workers/mp3Encoder.std.ts'),
  platform: 'browser',
  tsconfig: join(REPO, 'tsconfig.json'),
  transform: { define: { process: 'undefined', require: 'undefined', eval: 'undefined' } },
  onLog,
  output: { format: 'esm', file: join(OUT, 'bundles/workers/mp3Encoder.js'), minify, codeSplitting: false, generatedCode: { symbols: false } },
});

// Page and static assets.
let html = await readFile(join(HERE, 'index.html'), 'utf8');
const PRODUCTION_CONNECT_SRC = "connect-src 'self' wss://snowflake.torproject.net https://snowflake-broker.torproject.net;";
if (!html.includes(PRODUCTION_CONNECT_SRC)) throw new Error('index.html: connect-src changed, update build.mjs');
if (E2E) html = html.replace(PRODUCTION_CONNECT_SRC, `connect-src 'self' ${new URL(e2e.RELAY_URL).origin.replace(/^http/, 'ws')};`);
await writeFile(join(OUT, 'index.html'), html);
await cp(join(HERE, 'favicon.svg'), join(OUT, 'favicon.svg'));
// The app shell's own pieces (web/shell): its stylesheet, the web app
// manifest and receiver's icons.
await cp(join(WEB, 'shell/shell.css'), join(OUT, 'shell.css'));
await cp(join(HERE, 'manifest.webmanifest'), join(OUT, 'manifest.webmanifest'));
await cp(join(HERE, 'brand'), join(OUT, 'brand'), { recursive: true });

await mkdir(join(OUT, 'stylesheets'));
for (const name of ['manifest.css', 'quill.css', 'tailwind.css']) {
  let css = await readFile(join(REPO, 'stylesheets', name), 'utf8');
  // Electron's asset:// protocol serves files from the app root; here they
  // are static files next to stylesheets/. The large emoji font is an
  // optional download in Desktop; until the web build ships it, the bundled
  // emoji font covers both.
  css = css
    .replaceAll('asset:///optional-fonts/emoji-large.woff2', '../fonts/emoji.woff2')
    .replaceAll('asset:///', '../');
  if (/(asset|emoji|attachment):\/\//.test(css)) {
    throw new Error(`stylesheets/${name}: unhandled custom protocol URL`);
  }
  await writeFile(join(OUT, 'stylesheets', name), css);
}
for (const dir of ['fonts', 'images', 'sounds']) {
  await cp(join(REPO, dir), join(OUT, dir), { recursive: true });
}
// receiver's logo in place of Signal's (trademark): the splash screen, the
// link screen and the empty inbox use these files.
for (const [name, brand] of [
  ['signal-logo.svg', 'logo.svg'],
  ['signal-logo-and-wordmark.svg', 'wordmark.svg'],
  ['signal-logo-with-text.svg', 'wordmark.svg'],
]) {
  await cp(join(HERE, 'brand', brand), join(OUT, 'images', name));
}

await mkdir(join(OUT, 'locales'));
await cp(join(REPO, 'build/compact-locales'), join(OUT, 'locales'), { recursive: true });
for (const name of ['available-locales.json', 'locale-display-names.json', 'country-display-names.json']) {
  await cp(join(REPO, 'build', name), join(OUT, 'locales', name));
}

// The production build must not contain the test carrier or anything that
// could reach the test relay: no relay code in the JavaScript or in the
// transport's WebAssembly (built without webtor's test-relay feature), and
// the CSP's connect-src unchanged.
if (!E2E) {
  const markers = ['openRelay', 'relay-carrier', 'web-e2e-config', 'test relay', 'ws://127.0.0.1', 'ws://localhost'];
  const found = [];
  const scan = async dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (/\.(js|html|wasm)$/.test(entry.name)) {
        const text = (await readFile(path)).toString('latin1');
        for (const marker of markers) if (text.includes(marker)) found.push(`${relative(OUT, path)}: ${marker}`);
      }
    }
  };
  await scan(OUT);
  if (!html.includes(PRODUCTION_CONNECT_SRC)) found.push('index.html: connect-src changed');
  if (found.length) throw new Error(`production build contains test-only code:\n  ${found.join('\n  ')}`);
  console.log(`production check: no test relay code (${markers.length} markers), connect-src unchanged`);
}

// Subresource Integrity for the page's scripts, stylesheets and modules
// (scripts/sri.mjs), before the service worker records every file's digest.
const sriModules = await addIntegrity(join(OUT, 'index.html'));
const pageChunks = bundle.output.filter(o => o.type === 'chunk').length;
if (sriModules < pageChunks) throw new Error(`import map covers ${sriModules} of ${pageChunks} chunks`);
console.log(`integrity: index.html, ${sriModules} modules in its import map`);

// The service worker, with the list of every file above (web/sw).
const sw = await buildServiceWorker(OUT, { minify });
console.log(`service worker: build ${sw.build.slice(0, 16)}, ${sw.files} files, ${sw.core} core (${(sw.coreBytes / 1e6).toFixed(1)} MB)`);

// Report.
const chunks = bundle.output.filter(o => o.type === 'chunk');
const jsBytes = chunks.reduce((sum, c) => sum + Buffer.byteLength(c.code), 0);
const modules = new Set(chunks.flatMap(c => c.moduleIds));
const report = {
  seconds: (Date.now() - started) / 1000,
  chunks: chunks.length,
  jsBytes,
  modules: modules.size,
  shims: Object.fromEntries([...resolver.used].sort()),
  webSiblings: [...resolver.siblings].sort(),
};
console.log(`renderer: ${chunks.length} chunks, ${(jsBytes / 1e6).toFixed(2)} MB JS, ${modules.size} modules, ${report.seconds} s`);
console.log('shims:');
for (const [name, target] of Object.entries(report.shims)) console.log(`  ${name.padEnd(40)} ${target}`);
console.log(`web siblings: ${report.webSiblings.join(', ') || '(none)'}`);
const sqlChunks = sqlBundle.output.filter(o => o.type === 'chunk');
const sqlModules = new Set(sqlChunks.flatMap(c => c.moduleIds));
console.log(
  `sql worker: ${sqlChunks.length} chunks, ${(sqlChunks.reduce((sum, c) => sum + Buffer.byteLength(c.code), 0) / 1e6).toFixed(2)} MB JS, ${sqlModules.size} modules`
);
console.log('sql worker shims:');
for (const [name, target] of [...sqlResolver.used].sort()) console.log(`  ${name.padEnd(40)} ${target}`);
if (args.report) {
  report.moduleIds = [...modules].map(id => (id.startsWith(REPO) ? relative(REPO, id) : id)).sort();
  await writeFile(args.report, JSON.stringify(report, null, 2));
}
const total = execSync(`du -sb ${JSON.stringify(OUT)}`).toString().split('\t')[0];
console.log(`output: ${relative(process.cwd(), OUT) || OUT} ${(Number(total) / 1e6).toFixed(1)} MB, ${readdirSync(OUT).length} entries`);
