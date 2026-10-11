// SPDX-License-Identifier: AGPL-3.0-only
//
// Module resolution for the browser build of Desktop's main window.
//
// 1. Web siblings: an import that resolves to `X.preload.ts`, `X.node.ts`,
//    `X.main.ts`, `X.dom.ts` or `X.std.ts` (or .tsx) is redirected to
//    `X.web.ts` / `X.web.tsx` when that file exists. Upstream files stay
//    untouched; replacements live next to them.
// 2. Node builtins: browser polyfills, small shims, or modules whose every
//    export throws "not available in the web build: <module>.<name>".
// 3. Native and Electron-only packages: shims under web/renderer/shims.
//
// Every bare import that is neither a dependency nor listed here makes the
// build fail (see build.mjs), so nothing reaches the bundle unshimmed.

import { existsSync } from 'node:fs';
import { createRequire, builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const REPO = join(WEB, '..');
const SHIMS = join(WEB, 'renderer/shims');
const webRequire = createRequire(join(WEB, 'package.json'));
const pkgDir = name => dirname(webRequire.resolve(`${name}/package.json`));
// The package's entry file. (require.resolve would return Node's builtin for
// packages named like one: assert, events, util, ...)
const pkgMain = name => {
  const dir = pkgDir(name);
  const { main = 'index.js' } = webRequire(join(dir, 'package.json'));
  return join(dir, main.endsWith('.js') ? main : `${main}.js`);
};

export const LIBSIGNAL_PACKAGE = join(WEB, 'libsignal/dist/package');

// module -> [kind, target]. kind: 'polyfill' (established browser package),
// 'shim' (our glue, real behaviour), 'partial' (a shim for some exports,
// the rest throw "not available"), 'stub' (explicit "not available").
// Keys are Node builtin names without the `node:` prefix.
const BUILTINS = {
  assert: ['polyfill', pkgMain('assert')],
  'assert/strict': ['shim', join(SHIMS, 'node/assert-strict.ts')],
  buffer: ['shim', join(SHIMS, 'node/buffer.ts')],
  crypto: ['shim', join(SHIMS, 'node/crypto.ts')],
  diagnostics_channel: ['shim', join(SHIMS, 'node/diagnostics-channel.ts')],
  events: ['polyfill', pkgMain('events')],
  // The app's files in the origin private file system (web/main/files.ts).
  fs: ['partial', join(SHIMS, 'node/fs.ts')],
  'fs/promises': ['partial', join(SHIMS, 'node/fs-promises.ts')],
  http: ['partial', join(SHIMS, 'node/http.ts')],
  os: ['shim', join(SHIMS, 'node/os.ts')],
  path: ['polyfill', pkgMain('path-browserify')],
  process: ['shim', join(SHIMS, 'node/process.ts')],
  querystring: ['polyfill', pkgMain('querystring-es3')],
  'process/': ['shim', join(SHIMS, 'node/process.ts')],
  stream: ['polyfill', join(pkgDir('readable-stream'), 'lib/ours/browser.js')],
  'stream/promises': ['shim', join(SHIMS, 'node/stream-promises.ts')],
  'stream/web': ['shim', join(SHIMS, 'node/stream-web.ts')],
  string_decoder: ['polyfill', pkgMain('string_decoder')],
  timers: ['shim', join(SHIMS, 'node/timers.ts')],
  'timers/promises': ['shim', join(SHIMS, 'node/timers-promises.ts')],
  url: ['shim', join(SHIMS, 'node/url.ts')],
  util: ['shim', join(SHIMS, 'node/util.ts')],
  v8: ['shim', join(SHIMS, 'node/v8.ts')],
  zlib: ['polyfill', pkgMain('browserify-zlib')],
};

// Builtins whose every export throws when used. Networking goes through the
// Tor transport; the rest has no browser equivalent.
const UNAVAILABLE_BUILTINS = [
  'child_process',
  'cluster',
  'constants',
  'dgram',
  'dns',
  'dns/promises',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'perf_hooks',
  'readline',
  'tls',
  'tty',
  'vm',
  'worker_threads',
];

// Packages with native code or Electron-only behaviour that the renderer
// graph imports. (@signalapp/sqlcipher, @signalapp/windows-ucv and
// @indutny/simple-windows-notifications are not in it; if they appear, the
// build fails on their native addons and they get a stub here.)
const PACKAGES = {
  electron: ['shim', join(SHIMS, 'electron.ts')],
  '@signalapp/mute-state-change': ['stub', join(SHIMS, 'native/mute-state-change.ts')],
  '@indutny/mac-screen-share': ['stub', join(SHIMS, 'native/mac-screen-share.ts')],
  'fs-xattr': ['stub', join(SHIMS, 'native/fs-xattr.ts')],
  // Workspace package; its dist is built by its own prepare script, which
  // the web build does not run. The TypeScript source is the same code.
  '@signalapp/types': ['shim', join(REPO, 'packages/types/src/index.std.ts')],
};

// node-fetch's `fetch` goes through Tor (web/net/node-fetch.ts); the shim
// itself imports the real package.
const NODE_FETCH_SHIM = join(WEB, 'net/node-fetch.ts');

const WEB_SIBLING = /\.(preload|node|main|dom|std)\.(tsx?|js)$/;

const JUMBOMOJI_MANIFEST = join(REPO, 'build/jumbomoji.json');

const UNAVAILABLE_PREFIX = '\0web-unavailable:';

const PARTIAL_PREFIX = '\0web-partial:';

/**
 * Records which shims were used, for the build report. `overrides` maps
 * builtins (without `node:`) or packages to [kind, target] for one bundle
 * (the SQL worker has its own fs, worker_threads and sqlcipher). Kind
 * 'partial' is a builtin shim that implements some functions: every other
 * export of the Node module throws "not available". Kind 'unavailable'
 * (no target) makes every export throw.
 * @param {{ overrides?: Record<string, [string, string]> }} [options]
 * @returns {{ plugin: import('rolldown').Plugin, used: Map<string, string>, siblings: Set<string> }}
 */
export function webResolvePlugin({ overrides = {} } = {}) {
  const used = new Map();
  const siblings = new Set();
  const note = (name, kind, target) =>
    used.set(
      name,
      `${kind}: ${target.replace(/^.*\/node_modules\/\.pnpm\/([^/]+)\/node_modules\/.*$/, (_, pkg) => pkg.replace(/@([^@]+)$/, ' $1')).replace(`${REPO}/`, '')}`
    );

  return {
    used,
    siblings,
    plugin: {
      name: 'web-resolve',
      async resolveId(source, importer, options) {
        const bare = source.startsWith('node:') ? source.slice(5) : source;

        if (Object.hasOwn(overrides, bare)) {
          const [kind, target] = overrides[bare];
          if (kind === 'unavailable') {
            note(bare, 'stub', 'throws "not available in the web build"');
            return UNAVAILABLE_PREFIX + bare;
          }
          note(bare, kind, target);
          return kind === 'partial' ? `${PARTIAL_PREFIX}${bare}:${target}` : target;
        }
        if (Object.hasOwn(BUILTINS, bare)) {
          const [kind, target] = BUILTINS[bare];
          note(bare, kind, target);
          return kind === 'partial' ? `${PARTIAL_PREFIX}${bare}:${target}` : target;
        }
        if (UNAVAILABLE_BUILTINS.includes(bare)) {
          note(bare, 'stub', 'throws "not available in the web build"');
          return UNAVAILABLE_PREFIX + bare;
        }
        if (source.startsWith('node:') || (builtinModules.includes(bare) && !bare.startsWith('_'))) {
          // An unlisted builtin: fail loudly instead of bundling a surprise.
          this.error(`no web mapping for Node builtin "${source}" (imported by ${importer})`);
        }
        if (source === 'node-fetch' && importer !== NODE_FETCH_SHIM) {
          note('node-fetch', 'shim', 'fetch over Tor (web/net/node-fetch.ts), rest of the package real');
          return NODE_FETCH_SHIM;
        }
        if (Object.hasOwn(PACKAGES, source)) {
          const [kind, target] = PACKAGES[source];
          note(source, kind, target);
          return target;
        }
        if (source === 'pino') {
          // pino's browser build drops what Desktop's logger relies on
          // (hooks, redaction, the destination stream); its Node build works
          // in the browser with a custom destination (rotatingPinoDest.web.ts).
          const resolved = await this.resolve('pino/pino.js', importer, { ...options, skipSelf: true });
          note('pino', 'real', 'Node build (pino/pino.js) instead of its browser build');
          return resolved;
        }
        if (source === '@signalapp/libsignal-client' || source.startsWith('@signalapp/libsignal-client/')) {
          note('@signalapp/libsignal-client', 'real', 'web/libsignal/dist/package (WebAssembly)');
          const sub = source.slice('@signalapp/libsignal-client'.length);
          return this.resolve(sub ? join(LIBSIGNAL_PACKAGE, sub) : join(LIBSIGNAL_PACKAGE, 'dist/index.js'), importer, {
            ...options,
            skipSelf: true,
          });
        }

        if (!importer || !(source.startsWith('.') || source.startsWith('/'))) {
          return null;
        }
        if (source === './Native' && importer.includes('/@signalapp/ringrtc/dist/ringrtc/')) {
          // RingRTC's TypeScript layer is used as is; only its native addon
          // is replaced. Calling is not available in the web build.
          note('@signalapp/ringrtc', 'stub', 'TypeScript layer real, native addon stubbed (web/renderer/shims/native/ringrtc.ts)');
          return join(SHIMS, 'native/ringrtc.ts');
        }
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
        if (resolved?.id === JUMBOMOJI_MANIFEST) {
          // Jumbo emoji come from sheets the Electron main process downloads
          // and serves over emoji://; without them emoji render from the font.
          note('build/jumbomoji.json', 'shim', 'empty manifest');
          return join(SHIMS, 'jumbomoji.json');
        }
        const match = resolved?.id.match(WEB_SIBLING);
        if (!match) {
          return resolved;
        }
        const base = resolved.id.slice(0, -match[0].length);
        for (const ext of ['.web.ts', '.web.tsx']) {
          // A web sibling may build on the module it replaces.
          if (existsSync(base + ext) && importer !== base + ext) {
            siblings.add((base + ext).replace(`${REPO}/`, ''));
            return base + ext;
          }
        }
        return resolved;
      },
      async load(id) {
        if (id.startsWith(PARTIAL_PREFIX)) {
          const rest = id.slice(PARTIAL_PREFIX.length);
          const name = rest.slice(0, rest.indexOf(':'));
          const target = rest.slice(name.length + 1);
          const real = await import(`node:${name}`);
          const keys = Object.keys(real).filter(k => k !== 'default' && /^[A-Za-z_$][\w$]*$/.test(k));
          // CommonJS, like the unavailable modules below (graceful-fs patches it).
          return [
            `const impl = require(${JSON.stringify(target)});`,
            `const { unavailable } = require(${JSON.stringify(join(SHIMS, 'node/unavailable.ts'))});`,
            `const pick = k => (Object.hasOwn(impl, k) ? impl[k] : unavailable(${JSON.stringify(name)}, k));`,
            'module.exports = {',
            ...keys.map(k => `  ${k}: pick(${JSON.stringify(k)}),`),
            '};',
          ].join('\n');
        }
        if (!id.startsWith(UNAVAILABLE_PREFIX)) {
          return null;
        }
        const name = id.slice(UNAVAILABLE_PREFIX.length);
        // Same export names as Node's module, so named imports link; each one
        // throws when called or constructed. CommonJS, so that modules which
        // patch Node's exports (graceful-fs) get a plain, mutable object.
        const real = await import(`node:${name}`);
        const keys = Object.keys(real).filter(k => k !== 'default' && /^[A-Za-z_$][\w$]*$/.test(k));
        return [
          `const { unavailable } = require(${JSON.stringify(join(SHIMS, 'node/unavailable.ts'))});`,
          `const m = ${JSON.stringify(name)};`,
          'module.exports = {',
          ...keys.map(k => `  ${k}: unavailable(m, ${JSON.stringify(k)}),`),
          '};',
        ].join('\n');
      },
    },
  };
}
