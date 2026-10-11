// SPDX-License-Identifier: AGPL-3.0-only
//
// Builds Desktop's main window for the browser into OUT_DIR (default
// web/dist/app/, deployed at /receiver/app/):
//
//   index.html            from background.html, strict CSP, no inline script
//   app.js, chunks/       the renderer bundle (entry.ts -> preload graph)
//   chunks/libsignal_node.wasm   next to libsignal's loader
//   stylesheets/          Desktop's compiled SCSS + Tailwind (asset:/// -> ../)
//   fonts/ images/ sounds/
//   locales/              compact locale messages + display names
//   sql/worker.js, sql/chunks/   the SQL worker (web/sql/: Desktop's
//                         ts/sql/Server.node.ts on SQLite3 Multiple Ciphers)
//   sql/sqlite3.wasm, sql/signal_tokenizer.wasm
//
// Expects Desktop's generated sources (protobuf, emoji data, styles, compact
// locales) and web/sql/dist/; renderer/build.sh runs those generators and
// sql/build.sh first.
//
// Usage: node renderer/build.mjs [--out DIR] [--no-minify] [--report FILE]

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'rolldown';

import { webResolvePlugin, LIBSIGNAL_PACKAGE } from './resolve.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = join(HERE, '..');
const REPO = join(WEB, '..');

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: join(WEB, 'dist/app') },
    'no-minify': { type: 'boolean', default: false },
    report: { type: 'string' },
  },
});
const OUT = args.out;
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
  // The site is rebuilt and redeployed daily, so each build is valid for 30
  // days from when it was built: the limit Desktop accepts whatever the
  // auto-update setting (ts/util/buildExpiration.std.ts).
  const builtAt = sourceDateEpoch ? buildCreation : Date.now();
  return {
    name: 'receiver',
    version: packageJson.version,
    environment: 'production',
    buildCreation,
    buildExpiration: builtAt + 30 * 24 * 3600 * 1000,
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

const config = await staticConfig();
const STATIC_CONFIG_ID = '\0web-static-config';

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

const bundle = await build({
  cwd: REPO,
  input: { app: join(HERE, 'entry.ts') },
  platform: 'browser',
  tsconfig: join(REPO, 'tsconfig.json'),
  transform,
  plugins: [
    resolver.plugin,
    {
      name: 'web-static-config',
      resolveId: id => (id === 'virtual:web-static-config' ? STATIC_CONFIG_ID : null),
      load: id => (id === STATIC_CONFIG_ID ? `export default ${JSON.stringify(config)};` : null),
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
await cp(join(LIBSIGNAL_PACKAGE, 'wasm/libsignal_node.wasm'), wasmTarget);

// The SQL worker: its own bundle with its own fs, worker_threads and
// @signalapp/sqlcipher (web/sql/). It fetches its WebAssembly modules
// (relative to itself) and checks them against these digests.
const SQL_DIST = join(WEB, 'sql/dist');
const SQL_OUT = join(OUT, 'sql');
const SQL_ASSETS_ID = '\0web-sql-assets';
const sri = async path => `sha384-${createHash('sha384').update(await readFile(path)).digest('base64')}`;
const sqlAssets = {
  sqlite: { path: 'sqlite3.wasm', integrity: await sri(join(SQL_DIST, 'sqlite3mc/sqlite3.wasm')) },
  tokenizer: { path: 'signal_tokenizer.wasm', integrity: await sri(join(SQL_DIST, 'signal_tokenizer.wasm')) },
  // The page's copy (same URL, so the browser cache serves it).
  libsignal: { path: relative(SQL_OUT, wasmTarget), integrity: await sri(wasmTarget) },
};
const sqlResolver = webResolvePlugin({
  overrides: {
    fs: ['partial', join(WEB, 'sql/shims/fs.ts')],
    worker_threads: ['shim', join(WEB, 'sql/shims/worker-threads.ts')],
    '@signalapp/sqlcipher': ['real', join(WEB, 'sql/sqlcipher.ts')],
    sqlite3mc: ['real', join(SQL_DIST, 'sqlite3mc/sqlite3.mjs')],
  },
});
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
  output: { ...output, dir: SQL_OUT },
});
await cp(join(SQL_DIST, 'sqlite3mc/sqlite3.wasm'), join(SQL_OUT, 'sqlite3.wasm'));
await cp(join(SQL_DIST, 'signal_tokenizer.wasm'), join(SQL_OUT, 'signal_tokenizer.wasm'));
if (problems.length) {
  for (const p of problems) console.error(`error: ${p.split('\n')[0]}`);
  throw new Error(`${problems.length} unresolved imports or missing exports`);
}

// Page and static assets.
const html = await readFile(join(HERE, 'index.html'), 'utf8');
await writeFile(join(OUT, 'index.html'), html);
await cp(join(HERE, 'favicon.svg'), join(OUT, 'favicon.svg'));

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

await mkdir(join(OUT, 'locales'));
await cp(join(REPO, 'build/compact-locales'), join(OUT, 'locales'), { recursive: true });
for (const name of ['available-locales.json', 'locale-display-names.json', 'country-display-names.json']) {
  await cp(join(REPO, 'build', name), join(OUT, 'locales', name));
}

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
