# receiver on the web

Everything for the static web build lives in this directory, so merges from
upstream Signal Desktop never touch it. `web/` is its own pnpm workspace; the
repository root's `package.json` and lockfile belong to upstream.

The site is deployed to https://insertokname.github.io/receiver/ by
`.github/workflows/web-pages.yml` (on push to `main`, daily, and on demand).
The app is the site's root; `test/` and `libsignal/` are check pages.

| Path | What |
|---|---|
| `transport/webtor-rs/` | Tor client in Rust/WASM: git submodule, [insertokname/webtor-rs](https://github.com/insertokname/webtor-rs) branch `signal-web-transport` |
| `transport/src/index.js` | Connection policy: Snowflake WebSocket first, then Snowflake WebRTC, retried with backoff; Signal sockets pinned to Signal's CA |
| `transport/build.sh` | Builds `transport/dist/` (WASM, `signal-ca.js` from `config/default.json`, policy); `--test-relay` builds the end-to-end tests' variant into `transport/dist-e2e/` |
| `libsignal/libsignal/` | libsignal 0.103.0 (the version Desktop pins): git submodule, [insertokname/libsignal](https://github.com/insertokname/libsignal) branch `web-wasm` |
| `libsignal/build.sh` | Builds `libsignal/dist/package/`: `@signalapp/libsignal-client` with its native addon replaced by WebAssembly (see below) |
| `libsignal/loader.js` | Loads the WebAssembly module on emnapi; provides `initLibsignal()` |
| `libsignal/test/node.mjs` | Runs libsignal's own TypeScript tests against the WebAssembly build in Node |
| `libsignal/check/` | libsignal checks page (`libsignal/` on the site) and its headless runner `run.mjs` |
| `renderer/` | Desktop's main window bundled for the browser (the site's root): `build.sh`, `build.mjs`, module resolution (`resolve.mjs`), Node/Electron/native shims (`shims/`), entry point, page, boot test `run.mjs` |
| `main/` | In-page replacement for Electron's main process: IPC (`ipc.ts`), config, locale, settings, the database side (`sql.ts`), the app's files (`files.ts`), every other channel the renderer uses (`channels.ts`) |
| `sql/` | The SQL worker: Desktop's `ts/sql/Server.node.ts` and migrations on encrypted SQLite in the origin private file system (see below); `build.sh` fetches SQLite3 Multiple Ciphers and builds `tokenizer/`; `test/run.mjs` is the storage test |
| `sql/tokenizer/` | Signal's FTS5 tokenizer (Signal-FTS5-Extension, the revision `@signalapp/sqlcipher` uses) as a WebAssembly module (Rust) |
| `net/` | libsignal's `Net` for the web build (`WebNet`): chat and provisioning connections, the typed chat calls, and HTTPS (`node-fetch` replacement), all through one Tor client (`tor.ts`, chosen in `carrier.ts`); `test/run.mjs` checks it against Signal |
| `shell/` | The app shell around Desktop's UI: one window at a time ("Use here", `tabs.ts`), connection status (`status.ts`), the database error screens (`errors.ts`), storage persistence and wipe detection (`storage.ts`), the notification banner (`notifications.ts`), the service worker's update prompt (`update.ts`); `test/run.mjs` tests the recovery paths |
| `sw/` | The service worker (`sw.ts`, built by `build.mjs` with the app's file list into `sw.js`); `test/run.mjs` tests caching, offline and updates |
| `renderer/brand/`, `renderer/manifest.webmanifest` | receiver's logo and icons (in place of Signal's), the web app manifest |
| `e2e/` | End-to-end tests against Desktop's mock server (test-only, never deployed): `run.mjs` (scenarios), `mock.mjs`, `relay.mjs`, the test carrier `relay-carrier.ts`, `config.mjs` |
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
wasm-opt (binaryen); for the app the toolchain in
`sql/tokenizer/rust-toolchain.toml` (`wasm32-wasip1`) and unzip.

```bash
git submodule update --init web/transport/webtor-rs web/libsignal/libsignal
cd web
pnpm install --frozen-lockfile
bash transport/build.sh          # -> transport/dist/
bash libsignal/build.sh          # -> libsignal/dist/package/
(cd .. && pnpm install --frozen-lockfile --ignore-scripts)   # Desktop's dependencies, for the app
bash renderer/build.sh           # -> dist/app/ (Desktop's renderer and SQL worker; runs sql/build.sh)
bash scripts/build-site.sh       # -> dist/site/ (fetches a fresh Tor directory snapshot)
bash transport/build.sh --test-relay && node renderer/build.mjs --e2e   # -> dist/app-e2e/ (end-to-end tests only)
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

## Desktop's renderer in the browser

`renderer/build.sh` runs Desktop's own generators (protobuf code, emoji
data, stylesheets, compact locales; git-ignored outputs) and bundles the main
window (`ts/windows/main/preload.preload.ts`, the whole app) with rolldown as
browser ESM. `renderer/resolve.mjs` decides what every import becomes:

- `X.preload.ts` / `X.node.ts` / `X.main.ts` / `X.dom.ts` / `X.std.ts`
  resolve to a sibling `X.web.ts` when one exists. Web replacements are such
  new files; upstream files stay untouched.
- `electron` is `renderer/shims/electron.ts`: `ipcRenderer` dispatches to the
  in-page main process (`main/`).
- Node builtins map to browser polyfills (`buffer`, `events`,
  `path-browserify`, `readable-stream`, `assert`, `browserify-zlib`, ...),
  small shims (`crypto` on @noble/hashes + @noble/ciphers + Web Crypto
  randomness, its hashes and ciphers also streams; `fs` and `fs/promises`
  on the origin private file system, see "Files"; `process`, `os`,
  `timers`, `v8`, ...), or modules whose every export throws "not
  available in the web build: <module>.<name>" (`net`, `http(s)`,
  `worker_threads`, ...). An unmapped builtin, an unresolved import or a
  missing export fails the build.
- libsignal is `libsignal/dist/package`; RingRTC's TypeScript is used with
  its native addon stubbed (calling is disabled); other native modules are
  stubs.

The page (`renderer/index.html`, from Desktop's `background.html`) has no inline script and
the CSP `script-src 'self' 'wasm-unsafe-eval'`. `renderer/entry.ts` awaits
`initLibsignal()`, starts the in-page main process, imports the preload graph
and calls `window.startApp()`; progress is in `<html data-boot>`.

## Storage

Desktop's database code runs unchanged in a dedicated Web Worker
(`app/sql/worker.js`, built from `sql/worker.ts` by `renderer/build.mjs`
with its own `fs`, `worker_threads` and `@signalapp/sqlcipher`):

- SQLite is [SQLite3 Multiple Ciphers](https://github.com/utelle/SQLite3MultipleCiphers)'
  WebAssembly build (release pinned and checked by SHA-256 in `sql/build.sh`),
  in SQLCipher 4 format with Desktop's raw 32-byte key (`PRAGMA key =
  "x'...'"`): the file is the same format Desktop's SQLCipher writes.
  Its encrypting VFS wraps `opfs-sahpool`, SQLite's VFS on the origin private
  file system that needs no cross-origin isolation. The pool is
  OPFS `/userData/sql/` (Desktop: `<userData>/sql/db.sqlite`). Database,
  journal and WAL are encrypted; temporary tables stay in memory
  (`temp_store = MEMORY`), since temporary files would not be.
- `sql/sqlcipher.ts` has `@signalapp/sqlcipher`'s API and semantics (its
  Node addon's `lib/index.ts` and `src/addon.cc`) on SQLite's C API.
  Connections use exclusive locking (one connection owns the files), which
  also makes WAL work without shared memory.
- Full-text search uses Signal's own tokenizer, `signal_tokenizer`, compiled
  from Signal-FTS5-Extension (`sql/tokenizer/`) and registered with FTS5
  (`sql/tokenizer.ts`); search behaves as in Desktop (CJK, URLs, diacritics).
- The key (in place of Electron's safeStorage): 32 random bytes, stored in
  IndexedDB (`receiver-sql-key`) encrypted with AES-GCM under a
  non-extractable WebCrypto key; it only exists in the worker.
- One tab at a time: the worker holds the Web Lock `receiver:database` while
  it has the database; another tab waits up to 5 s (a reload's old worker
  shutting down), then fails with `DatabaseInUseError` without touching the
  files ("Use here", see "App shell").
- The worker loads libsignal too (Desktop's SQL code imports it): the same
  `libsignal_node.wasm` as the page, checked against the same digest. All
  WebAssembly the worker loads is fetched with SRI digests recorded at build
  time.
- `web/main/sql.ts` is the page side (Electron's MainSQL): the SQL IPC
  channels, paused writes, `remove-db` / `erase-*`, closing the database on
  `pagehide` or for another window, and reporting database failures to the
  app shell.

## Files

Desktop keeps attachments, avatars, drafts, stickers, downloads and temp
files under userData; the web build keeps them in the origin private file
system under `/userData/` (`main/files.ts`), next to the database's
`/userData/sql/`, which only the SQL worker touches. The renderer's `fs`
and `fs/promises` (`renderer/shims/node/fs*.ts`) implement what Desktop
and fs-extra use: callbacks, promises, `FileHandle`, read and write streams,
and `existsSync` / `realpathSync` from an in-memory copy of the directory
tree, read at startup and kept up to date. OPFS writes go to a copy that
replaces the file on close; where Node behaves differently and Desktop
relies on it, the shim keeps Node's behaviour (opening with `'w'`
truncates at once; a handle that never wrote changes nothing on close;
removing an open file works). Paths outside userData fail with `EACCES`.
Desktop encrypts attachments itself before they are written.

## Test

`CHROMIUM` must point at a Chromium or Chrome executable. The runners serve
`dist/site/` under `/receiver/` from `http://pages.example:8080` (mapped to
127.0.0.1), like GitHub Pages.

```bash
node transport-test/run.mjs 'suites=ws'               # basic checks over Snowflake WebSocket
node transport-test/run.mjs 'suites=webrtc'           # same over Snowflake WebRTC
BLACKHOLE=snowflake.torproject.net node transport-test/run.mjs 'suites=chain'   # fallback to WebRTC
node transport-test/run.mjs 'suites=ws&only=bulk,hold&hold=30'                  # long checks, local only
node libsignal/check/run.mjs                          # libsignal in the browser under the site's CSP
node libsignal/check/run.mjs https://insertokname.github.io/receiver/
node libsignal/test/node.mjs                          # libsignal's TypeScript tests (Node, no browser)
node sql/test/run.mjs                                 # storage: create/migrate, reopen, encrypted at rest, second tab, erase
node renderer/run.mjs                                 # web app boots to Desktop's link QR code (decoded) under the app's CSP
node renderer/run.mjs https://insertokname.github.io/receiver/
node renderer/test/crypto-shim.mjs                    # node:crypto shim against Node's node:crypto
node renderer/test/fs-shim.mjs                        # node:fs on the origin private file system, in the browser
node net/test/run.mjs                                 # WebNet + HTTPS through Tor against Signal (bogus credentials only)
node e2e/run.mjs                                      # end-to-end against Desktop's mock server (see below)
node sw/test/run.mjs                                  # service worker: cache, offline, updates only with consent, manifest
node shell/test/run.mjs                               # app shell: database error screens, wiped data, a hung second window, Mac shortcuts
node shell/test/device-name.mjs                       # the linked device's name for common browsers (Node)
BLACKHOLE=snowflake.torproject.net node renderer/run.mjs   # link screen while Tor falls back to WebRTC (~50 s): "Connecting...", no error
```

### End-to-end tests

`e2e/run.mjs` links the app to Desktop's own mock server
(`packages/mock-server`, built in place on first use; Desktop's root
dependencies must be installed) and runs scenarios modelled on
`ts/test-mock/`: link (QR code, registration, keys, authenticated socket,
inbox), sync (contacts, a group), receive, send (typed into the composer,
decrypted by the mock contact), persistence (reload, reconnect, a dropped
connection) and link-and-sync (message history imported from the primary's
ephemeral backup), "Use here" (a second window takes over) and
notifications (the permission banner, a notification for a message while
the window is not focused, clicking it). It needs the e2e build:

- `transport/build.sh --test-relay` compiles webtor-rs with its
  `test-relay` feature (`Carrier::Relay`: TLS carried by a WebSocket to a
  local relay) into `transport/dist-e2e/`.
- `renderer/build.mjs --e2e` builds `dist/app-e2e/`: the same app with
  `net/carrier.ts` (Tor) replaced by `e2e/relay-carrier.ts`, the mock
  server's URLs (`https://localhost`), CA, zkgroup parameters and trust
  root (`e2e/config.mjs`), and a CSP that allows the relay
  (`ws://127.0.0.1:18791`, `E2E_RELAY_PORT`). The choice is made at build
  time: the production build has no relay code and no switch, and fails
  if any is found in its output.
- `e2e/relay.mjs` (Node) relays the app's WebSockets to the mock server's
  TCP port; TLS runs end to end, pinned to the mock's CA.

`ONLY=a,b` runs the first scenarios, `VERBOSE=1` prints the app's log,
`E2E_ARTIFACTS=<dir>` saves a screenshot when a scenario fails.

## App shell

What Electron and the operating system give Desktop, and what a web app
needs on top (`shell/`, started by `renderer/entry.ts`), modelled on
WhatsApp Web:

- **Service worker** (`sw/`): `sw.js` lists every file of the app with its
  SHA-256 and a build id (the digest of that list). Installing stores the
  core files (code, WebAssembly, styles, English strings), each checked
  against its digest; images, sounds, fonts and other languages are stored
  when first used. The worker serves the *approved* build: a new
  deployment's worker downloads its files in the background, then the page
  shows "A new version of receiver is available - Click to reload"; only
  that click switches. The Tor directory snapshot (`transport/tor/`) is
  data: fetched from the network when possible, from the cache offline,
  and not part of the build id, so the daily redeployment offers no update.
  Builds are deterministic (the build expiration comes from the commit's
  date: 90 days, as a packaged Desktop build).
- **One window at a time** ("Use here", `shell/tabs.ts`): the window using
  the app holds the Web Lock `receiver:window`; a new window that finds it
  held asks on the BroadcastChannel `receiver:tabs` and, if answered, shows
  "receiver is open in another window" without starting anything. "Use
  here" asks the other window to close its database (the SQL worker's
  close, which releases `receiver:database`); it confirms and reloads into
  the same screen. A window that does not answer (hung, or a reload's old
  page) gets the database lock wait, then the same screen.
- **Connection status**: while Tor connects, the link screen waits (its
  first QR code attempt has only 10 s) and shows "Connecting..." instead;
  on the link screen a banner shows reconnects. In the inbox, Desktop's own
  network status applies.
- **Database errors** (Electron's dialogs): another window -> "Use here";
  missing key or corrupted file -> "Delete data and link again" (Desktop's
  remove-db / erase-sql-key paths); storage full -> say so.
- **Storage**: `navigator.storage.persist()` is asked once, right after
  linking (never on a first visit: Firefox prompts for it); refused is
  remembered and not asked again. A linked app whose database disappeared
  explains that and goes to the link screen. Safari: the link screen asks
  to add the app to the Dock / Home Screen (7-day storage limit).
- **Notifications**: Desktop's notification service uses the browser's
  Notification API (its Linux path). Permission is asked from a dismissible
  banner in the chat list, never on load. Focus is reported to Desktop
  (`set-window-focus`), so notifications appear while the window is not
  focused, like Desktop.
- **Branding**: receiver's logo replaces Signal's in the splash screen, link
  screen and empty inbox (`renderer/brand/`, copied over `images/signal-logo*.svg`
  at build time); the title is "receiver"; the link screen and the shell's
  screens say that receiver is unofficial and link to the source (AGPL).
- **Device name**: the phone lists the linked device as "receiver
  (Chrome, Linux)", "receiver (Safari, iOS)", ... (`shell/device-name.ts`,
  from client hints or the user agent), through `ts/util/os/osMain.web.ts`
  / `osPreload.web.ts` (Desktop names a linked device `OS.getName()`).
- **Link screen retries**: Desktop gives up on the QR code after a
  connection error or timeout; over Tor the shell retries its installer
  with backoff behind "Connecting...", and the provisioning connection's
  timeout is reported as Desktop's `ConnectTimeoutError` so its timeouts
  grow (10, 20, 30, 60 s).
- **Mac**: Desktop runs its Linux code paths (`process.platform`), but on a
  Mac `window.platform` is `darwin`, so shortcuts and their labels use Cmd.

## Network

libsignal-net (chat, CDSI, SVR, registration, key transparency) is not in
the WebAssembly build; `net/` implements the part of libsignal's `Net`
Desktop uses, with libsignal's TypeScript types and its semantics (paths,
headers, timeouts and error codes from libsignal-net's Rust code):

- One Tor client per page (`net/tor.ts`), bootstrapped when the app starts
  (`renderer/entry.ts`). Each Signal connection is its own Tor stream with
  TLS 1.3 (rustls, in the transport's Rust code) trusting only Signal's CA.
  Repeated failures or HTTP 429 get a new circuit; continued failures
  replace the Tor client (bootstrapped again with backoff) and interrupt
  every connection on the old one.
- Chat: `wss://chat.signal.org/v1/websocket/` (unauthenticated,
  authenticated with Basic auth, `x-signal-receive-stories`,
  `Accept-Language`) and `/v1/websocket/provisioning/`, WebSocketMessage
  protobufs (protopiler output, `net/generated/`). Ping after 31 s idle,
  disconnect after 45 s without anything from the server, like
  libsignal-net. Every failure reaches the listener's
  `onConnectionInterrupted` with libsignal's error code.
- Typed calls: libsignal's REST-over-WebSocket requests. Calls libsignal
  only makes over gRPC (devices, username reservation and links) use the
  chat server's REST endpoints for the same operations.
- HTTPS (`net/node-fetch.ts`, replacing `node-fetch`'s `fetch`): hyper's
  HTTP/1.1 client over rustls over Tor, keep-alive connections reused per
  host. Trust is exactly Desktop's: Desktop pins Signal's CA (`ca`) for
  every Signal host it fetches from (storage service, CDNs, updates2
  resources, upload locations). Requests without a pinned CA (link
  previews via contentproxy, Stripe) are refused for now.
- Not available yet, rejecting with typed libsignal errors: CDSI (needs SGX
  attestation), SVR2, registration, key transparency, backups.
- The User-Agent is `unofficial-web-client/<version> (receiver)`.
- The carrier under TLS is an interface (`Carrier` in `net/tor.ts`, the
  `Carrier` enum in webtor-rs `signal_socket.rs`), chosen at build time in
  `net/carrier.ts`: Tor in every deployed build; the end-to-end tests'
  build replaces the module (see "End-to-end tests").
- The chat server's host and its trust root come from the app's config
  (`serverUrl`, `certificateAuthority`), as for Desktop: Signal's in
  production builds.

