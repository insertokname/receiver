# receiver on the web

Everything for the static web build lives in this directory, so merges from
upstream Signal Desktop never touch it. `web/` is its own pnpm workspace; the
repository root's `package.json` and lockfile belong to upstream.

The site is deployed to https://insertokname.github.io/receiver/ by
`.github/workflows/web-pages.yml` (on push to `main`, daily, and on demand).

| Path | What |
|---|---|
| `transport/webtor-rs/` | Tor client in Rust/WASM: git submodule, [insertokname/webtor-rs](https://github.com/insertokname/webtor-rs) branch `signal-web-transport` |
| `transport/src/index.js` | Connection policy: Snowflake WebSocket first, then Snowflake WebRTC, retried with backoff; Signal sockets pinned to Signal's CA |
| `transport/build.sh` | Builds `transport/dist/` (WASM, `signal-ca.js` from `config/default.json`, policy) |
| `libsignal/libsignal/` | libsignal 0.103.0 (the version Desktop pins): git submodule, [insertokname/libsignal](https://github.com/insertokname/libsignal) branch `web-wasm` |
| `libsignal/build.sh` | Builds `libsignal/dist/package/`: `@signalapp/libsignal-client` with its native addon replaced by WebAssembly (see below) |
| `libsignal/loader.js` | Loads the WebAssembly module on emnapi; provides `initLibsignal()` |
| `libsignal/test/node.mjs` | Runs libsignal's own TypeScript tests against the WebAssembly build in Node |
| `libsignal/check/` | libsignal checks page (`libsignal/` on the site) and its headless runner `run.mjs` |
| `app/` | Start page: bootstraps Tor and opens Signal's provisioning socket; `smoke.mjs` checks it in headless Chromium |
| `transport-test/` | Transport checks page (`test/` on the site) and its headless runner `run.mjs` |
| `lib/signal.js` | Signal WebSocket framing shared by the pages |
| `protos/SubProtocol.proto` | Signal's WebSocket message definitions (restored from upstream history) |
| `scripts/build-site.sh` | Assembles `dist/site/`, including a fresh Tor directory snapshot |

## Build

Needs the Rust toolchain pinned in `transport/webtor-rs/rust-toolchain.toml`
(with the `wasm32-unknown-unknown` target), wasm-pack 0.15, clang and llvm-ar
able to target wasm32 (for ring), node 24, pnpm 11, brotli and curl. For
libsignal also the toolchain pinned in `libsignal/libsignal/rust-toolchain`
with the `wasm32-wasip1` target and the `rust-src` component, protoc and
wasm-opt (binaryen).

```bash
git submodule update --init web/transport/webtor-rs web/libsignal/libsignal
cd web
pnpm install --frozen-lockfile
bash transport/build.sh          # -> transport/dist/
bash libsignal/build.sh          # -> libsignal/dist/package/
bash scripts/build-site.sh       # -> dist/site/ (fetches a fresh Tor directory snapshot)
```

## libsignal

Signal Desktop uses `@signalapp/libsignal-client`: TypeScript over a native
Node-API addon. The web build compiles libsignal's own Node bridge
(`rust/bridge/node`, the same code as the addon) to `wasm32-wasip1` and runs it
on [emnapi](https://github.com/toyobayashi/emnapi), an implementation of
Node-API for WebAssembly; the TypeScript layer is libsignal's, unchanged.
`libsignal/dist/package/` has the package's layout (`dist/*.js`,
`zkgroup.js`, ...), so the bundler can alias `@signalapp/libsignal-client`
and its subpaths to it. Its `wasm/` holds the module and the loader.

- WebAssembly is instantiated asynchronously, but the package loads its
  native module when it is first imported. The app entry point must run
  `await initLibsignal()` (from `@signalapp/libsignal-client/wasm/index.js`)
  before it imports anything that imports libsignal, e.g. by importing the
  rest of the app dynamically afterwards (see `libsignal/check/main.js`).
  Importing libsignal earlier throws a clear error. `initLibsignal()` fetches
  `libsignal_node.wasm` from next to the loader and checks it against the
  SHA-384 digest recorded at build time; after a failure it can be retried.
- Networking (libsignal-net: chat, CDSI, SVR, key transparency, registration)
  is not part of the build; those functions throw "not available in the web
  build". Desktop's `Net` usage is reimplemented over the Tor transport.
- Randomness comes only from `crypto.getRandomValues`; Rust panics unwind
  into JavaScript exceptions as in the native addon.
- The bundler must map the `node:` modules the package's TypeScript uses:
  `node:buffer` (the `buffer` package), `node:crypto` (`randomBytes`,
  `randomUUID`), `node:assert`, and `node:stream` for `incremental_mac`.
  `libsignal/check/build.mjs` shows a minimal setup.

## Test

`CHROMIUM` must point at a Chromium or Chrome executable. The runners serve
`dist/site/` under `/receiver/` from `http://pages.example:8080` (mapped to
127.0.0.1), like GitHub Pages.

```bash
node app/smoke.mjs                                    # start page reaches "provisioning address received"
node app/smoke.mjs https://insertokname.github.io/receiver/
node transport-test/run.mjs 'suites=ws'               # basic checks over Snowflake WebSocket
node transport-test/run.mjs 'suites=webrtc'           # same over Snowflake WebRTC
BLACKHOLE=snowflake.torproject.net node transport-test/run.mjs 'suites=chain'   # fallback to WebRTC
node transport-test/run.mjs 'suites=ws&only=bulk,hold&hold=30'                  # long checks, local only
node libsignal/check/run.mjs                          # libsignal in the browser under the site's CSP
node libsignal/check/run.mjs https://insertokname.github.io/receiver/
node libsignal/test/node.mjs                          # libsignal's TypeScript tests (Node, no browser)
```
