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
| `app/` | Start page: bootstraps Tor and opens Signal's provisioning socket; `smoke.mjs` checks it in headless Chromium |
| `transport-test/` | Transport checks page (`test/` on the site) and its headless runner `run.mjs` |
| `lib/signal.js` | Signal WebSocket framing shared by the pages |
| `protos/SubProtocol.proto` | Signal's WebSocket message definitions (restored from upstream history) |
| `scripts/build-site.sh` | Assembles `dist/site/`, including a fresh Tor directory snapshot |

## Build

Needs the Rust toolchain pinned in `transport/webtor-rs/rust-toolchain.toml`
(with the `wasm32-unknown-unknown` target), wasm-pack 0.15, clang and llvm-ar
able to target wasm32 (for ring), node 24, pnpm 11, brotli and curl.

```bash
git submodule update --init web/transport/webtor-rs
cd web
pnpm install --frozen-lockfile
bash transport/build.sh          # -> transport/dist/
bash scripts/build-site.sh       # -> dist/site/ (fetches a fresh Tor directory snapshot)
```

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
```
