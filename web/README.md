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
| `transport/build.sh` | Builds `transport/dist/` (WASM and its SRI digest, `signal-ca.js` from `config/default.json`, policy); `--test-relay` builds the end-to-end tests' variant into `transport/dist-e2e/` |
| `transport/verify-directory.mjs` | Verifies a Tor directory snapshot with the transport's own WebAssembly (build-site.sh runs it) |
| `libsignal/libsignal/` | libsignal 0.103.0 (the version Desktop pins): git submodule, [insertokname/libsignal](https://github.com/insertokname/libsignal) branch `web-wasm` |
| `libsignal/build.sh` | Builds `libsignal/dist/package/`: `@signalapp/libsignal-client` with its native addon replaced by WebAssembly (see below) |
| `libsignal/loader.js` | Loads the WebAssembly module on emnapi; provides `initLibsignal()` |
| `libsignal/test/node.mjs` | Runs libsignal's own TypeScript tests against the WebAssembly build in Node |
| `libsignal/check/` | libsignal checks page (`libsignal/` on the site) and its headless runner `run.mjs` |
| `renderer/` | Desktop's main window bundled for the browser (the site's root): `build.sh`, `build.mjs`, module resolution (`resolve.mjs`), Node/Electron/native shims (`shims/`), entry point, page, boot test `run.mjs` |
| `main/` | In-page replacement for Electron's main process: IPC (`ipc.ts`), config, locale, settings, the database side (`sql.ts`), the app's files (`files.ts`), attachments (`attachments.ts`, `protocols.ts`, `local-urls.ts`, `downloads.ts`), every other channel the renderer uses (`channels.ts`) |
| `sql/` | The SQL worker: Desktop's `ts/sql/Server.node.ts` and migrations on encrypted SQLite in the origin private file system (see below); `build.sh` fetches SQLite3 Multiple Ciphers and builds `tokenizer/`; `test/run.mjs` is the storage test |
| `sql/tokenizer/` | Signal's FTS5 tokenizer (Signal-FTS5-Extension, the revision `@signalapp/sqlcipher` uses) as a WebAssembly module (Rust) |
| `net/` | libsignal's `Net` for the web build (`WebNet`): chat and provisioning connections, the typed chat calls, and HTTPS (`node-fetch` replacement), all through one Tor client (`tor.ts`, chosen in `carrier.ts`); `test/run.mjs` checks it against Signal |
| `shell/` | The app shell around Desktop's UI: one window at a time ("Use here", `tabs.ts`), connection status (`status.ts`), the database error screens (`errors.ts`), storage persistence and wipe detection (`storage.ts`), the notification banner (`notifications.ts`), the service worker's update prompt (`update.ts`), the "browser can't run receiver" screen (`support.ts`); `test/run.mjs` tests the recovery paths |
| `sw/` | The service worker (`sw.ts`, built by `build.mjs` with the app's file list into `sw.js`); `test/run.mjs` tests caching, offline and updates |
| `renderer/brand/`, `renderer/manifest.webmanifest` | receiver's logo and icons (in place of Signal's), the web app manifest |
| `e2e/` | End-to-end tests against Desktop's mock server (test-only, never deployed): `run.mjs` (scenarios), `mock.mjs`, `relay.mjs`, the test carrier `relay-carrier.ts`, `config.mjs` |
| `transport-test/` | Transport checks page (`test/` on the site) and its headless runner `run.mjs` |
| `lib/signal.js` | Signal WebSocket framing shared by the pages |
| `protos/SubProtocol.proto` | Signal's WebSocket message definitions (restored from upstream history) |
| `scripts/build-site.sh` | Assembles `dist/site/`, including a fresh, verified Tor directory snapshot, `SHA256SUMS` and `SOURCE` |
| `scripts/sri.mjs` | Adds Subresource Integrity to a built page (scripts, stylesheets, an import map with every module's digest) |
| `scripts/verify-site.sh` | Rebuilds the commit a deployment names and compares it with the deployed files |
| `scripts/harness.mjs`, `scripts/tunnel-proxy.mjs` | Shared by the browser test runners (site server, Chromium or Firefox, network and CSP watch); a local proxy that black-holes the bridge connection for the liveness tests |
| `scripts/real-tor.sh` | Runs a CI check that goes through the real Tor network once more if it fails (a Snowflake or circuit failure outside this code must not stop the daily Tor directory refresh) |

## Build

Needs the Rust toolchain pinned in `transport/webtor-rs/rust-toolchain.toml`
(with the `wasm32-unknown-unknown` target), wasm-pack 0.15, clang and llvm-ar
able to target wasm32 (for ring), node 24, pnpm 11, brotli, openssl and curl. For
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
bash scripts/build-site.sh       # -> dist/site/ (fetches and verifies a fresh Tor directory snapshot)
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
removing an open file works; `rmSync`/`unlinkSync` change the tree at
once and OPFS before any later access). Paths outside userData fail with
`EACCES`. Desktop encrypts attachments itself before they are written. A
write the browser refuses (quota) fails with Node's `ENOSPC` and the app
shell shows its "Not enough storage space" screen. Files Desktop's SQL code
deletes (migrations) are deleted by the page on the worker's request.

## Attachments

- **Showing them.** Desktop's renderer loads decrypted media from
  `attachment://` URLs, answered by its main process
  (`app/attachment_channel.main.ts`). The web build runs that module itself,
  unchanged, in the page (`main/attachments.ts`; the `electron` shim gives it
  `ipcMain` and `protocol`): it decrypts the locally encrypted file on the
  fly, verifies it as Desktop does (the whole file's MAC first, then each
  chunk against an incremental MAC as it is served) and answers Range
  requests. `ts/util/getLocalAttachmentUrl.web.ts` turns Desktop's URL into
  `<app>/attachment/<token>`: the original URL (it carries the attachment's
  keys) sealed with AES-GCM under a key that exists only in the page's
  memory (`main/local-urls.ts`), so nothing secret is ever in a URL that
  could reach the network. The service worker (`sw/sw.ts`) sends each such
  request to the page that made it over a MessageChannel and streams the
  answer back piece by piece as the browser reads it (`main/protocols.ts`
  has the protocol): images, video and audio with seeking (206, complete
  `Content-Range`), avatars, stickers, link preview images.
- **Saving.** Saving an attachment is a browser download (WhatsApp Web
  style): a hidden frame loads the attachment's local URL with
  `Content-Disposition: attachment` and the service worker streams the
  decrypted file into the download (`ts/util/Attachment.web.ts`,
  `main/downloads.ts`); data already in memory is saved from a Blob
  (`ts/windows/main/attachments.web.ts`).
- **Downloading and uploading** use Desktop's own code (download jobs,
  resumed with Range; tus uploads to CDN 3, resumed with HEAD + PATCH)
  over the HTTPS client through Tor. Request bodies are streamed: the
  transport pulls the file piece by piece (`net/node-fetch.ts`, webtor-rs
  `RequestBody::Stream`); the request's timeout then bounds each wait.
- **Voice notes** are recorded with Desktop's MP3 encoder worklet
  (`bundles/workers/mp3Encoder.js`, LAME compiled to JavaScript); the
  browser asks for the microphone when recording starts.
- Not available: playing a video while it downloads (an OPFS file shows
  its content only once its writer closes; the player waits for the
  download).

## Test

`CHROMIUM` must point at a Chromium or Chrome executable. The runners serve
`dist/site/` under `/receiver/` from `http://pages.example:8080` (mapped to
127.0.0.1), like GitHub Pages. `BROWSER=firefox FIREFOX=<path>` runs the
transport checks, the boot test and the end-to-end tests in Firefox
(WebDriver BiDi) instead.

```bash
node transport-test/run.mjs 'only=directory'          # Tor directory verification: the snapshot and tampered copies (no network)
node transport-test/run.mjs 'suites=ws'               # basic checks over Snowflake WebSocket
node transport-test/run.mjs 'suites=ws&only=basic,upload'   # + uploads of 64 KB to 1 MB to Signal (CI)
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
LIVENESS=1 node transport-test/run.mjs 'suites=ws&only=liveness'   # an idle connection is kept; a black-holed bridge connection is noticed (CI)
LIVENESS=1 node renderer/run.mjs                      # the app notices a black-holed bridge and shows a new QR code
node --test transport/test/ranged.test.mjs            # parallel ranged downloads against a fake server (Node)
node transport-test/perf.mjs                          # measurements over real Tor (see below)
```

`transport-test/perf.mjs` measures the transport over real Snowflake and
Tor, a fresh browser profile per run (`RUNS`, default 3), and prints the
median and range of: bootstrap time and its stages, chat connection time,
chat round trip idle and during a large download, HTTPS time to the
response head on a new and on a kept-alive connection, and the speed of a
`SIZE_MB` (16) download as one stream and in parallel ranges. `HIDDEN=1`
repeats the download with the page hidden (Chromium and Firefox then run
its timers once a second), `APP=1` measures the app instead (page load to
Tor ready and to the link QR code, cold and after a reload served by the
service worker), `CC=0` uses Tor's fixed window instead of congestion
control, `SITE=<dir>` measures another build. It uses only Signal's hosts
(no account): the chat server and Desktop's public release files on
`updates2.signal.org` (Signal's CA, Range requests) as the download. The
page is served by the runner only, never part of the site. Real Tor varies
a lot between circuits and over the day: compare builds run back to back,
over several runs; CI records one run and never fails on it.

`LIVENESS=1` sends the browser's traffic to the bridge through a local
proxy (`scripts/tunnel-proxy.mjs`) that can make every open connection stop
forwarding without closing it, like a bridge connection that silently
stops delivering; new connections still work.

### End-to-end tests

`e2e/run.mjs` links the app to Desktop's own mock server
(`packages/mock-server`, built in place on first use; Desktop's root
dependencies must be installed) and runs scenarios modelled on
`ts/test-mock/`: link (QR code, registration, keys, authenticated socket,
inbox), sync (contacts, a group), receive, send (typed into the composer,
decrypted by the mock contact), persistence (reload, reconnect, a dropped
connection) and link-and-sync (message history imported from the primary's
ephemeral backup), "Use here" (a second window takes over),
notifications (the permission banner, a notification for a message while
the window is not focused, clicking it) and the debug log view.
Scenarios (p)-(z) (`e2e/attachments.mjs`) cover attachments: receiving an
image, a file (saved as a browser download), a 31 MiB video (Range, 206,
bounded memory), a voice note, a profile picture, a sticker and a link
preview image; sending an image, a file and a video and recording a voice
note (Alice decrypts each); a download and an upload dropped half way and
resumed; storage full. `BROWSER=firefox FIREFOX=<path>` runs all of them in
Firefox (WebDriver BiDi; CI runs both browsers). Scenarios (i)-(o) and (aa)
link while every connection drops or stalls (the relay stops forwarding
without closing, like a hung Tor circuit) at the critical points of
linking, including half way through a 32 MiB archive download resumed with
Range and a 20 s outage as the keys are uploaded; each must end with
contacts synced and messages processed within a time bound. In (ab) every
connection stalls while the app is idle in the inbox: it must notice,
reconnect and show the message sent meanwhile within 60 s. It needs the
e2e build:

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
- **Debug log**: Desktop has it in its Help menu; the web build has no
  native menu, so it is in Settings > General ("Debug log",
  `ts/components/preferences/DebugLogItem.web.tsx`), and on the link screen
  ("Problems linking?"). It can be copied or saved as a file; there is no
  upload.
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
  at build time), and in the centre of the link QR code
  (`ts/components/BrandedQRCode.web.tsx`); the title is "receiver". Colours
  are Desktop's own.
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

## Browsers

The app needs WebAssembly, the origin private file system with writable
files on the page (`FileSystemFileHandle.createWritable`) and synchronous
access handles in workers (SQLite's `opfs-sahpool`), Web Locks,
BroadcastChannel, IndexedDB and Web Crypto. A browser without one of them
gets "This browser can't run receiver" (`shell/support.ts`) instead of a
half-working app.

- **Chromium** (Chrome, Edge) and **Firefox**: every test runs in both
  (CI: transport checks, boot to the QR code and the end-to-end suite;
  Firefox 155 locally, the runner image's Firefox in CI).
- **Safari** is not tested on a Mac. On Linux, Playwright's WebKit build
  (WPE, Safari 26.5 user agent) runs the transport checks (Tor over the
  Snowflake WebSocket bridge, TLS pinned to Signal's CA, uploads) and the
  libsignal checks; it has no origin private file system, so the app
  itself stops at the "can't run" screen there, and storage, the service
  worker's media route and linking were not exercised in WebKit. Known
  differences that matter in Safari:
  - `createWritable` on the page is recent in Safari (Safari 26); older
    versions get the "can't run" screen. Moving the app's file I/O into a
    worker (synchronous access handles, available since Safari 15.2) would
    lift that, and would also let a video play while it downloads.
  - Storage: Safari may delete a site's data after 7 days without a visit
    unless the app is added to the Dock / Home Screen; `persist()` is only
    granted to such an installed app. The link screen says so.
  - Notifications: Safari on macOS shows them; on iOS the Notification API
    exists only in an app added to the Home Screen (iOS 16.4 and later).
  - The Snowflake WebRTC fallback (when the WebSocket bridge is blocked)
    uses `RTCPeerConnection` data channels, which Safari has; not tested.
  - iOS suspends a page in the background: the connection drops and is
    noticed and re-established when the page comes back (see "Network",
    liveness).

## Integrity and reproducible builds

- **Subresource Integrity.** The app's `index.html` carries an
  `integrity` digest (SHA-384) for its script and stylesheets and an
  import map with the digest of every JavaScript module the page imports,
  statically or later (`scripts/sri.mjs`; its CSP allows exactly that
  import map by its hash). What the page fetches besides modules is checked
  against digests compiled into those modules: the WebAssembly (transport,
  libsignal, SQLite, the search tokenizer), the SQL worker (fetched with
  its digest before it starts; a worker's own script cannot carry one) and
  the locale files. The check pages (`test/`, `libsignal/`) get the same.
  Not covered by SRI: the service worker's script (browsers fetch it
  themselves; it holds the SHA-256 of every file and switches to a new
  build only when the user clicks the update prompt) and the voice note
  encoder worklet (served by the service worker from its checked cache).
  Apart from those two, `index.html`'s digest (in `SHA256SUMS`) pins all
  the code the page runs.
- **Published hashes.** Every deployment has `SHA256SUMS` (every file
  except the Tor directory snapshot, which is data that changes daily and
  is verified by its signatures) and `SOURCE` (the commit and submodule
  commits it was built from) at the site's root.
- **Reproducible builds.** Building a commit gives the same files
  wherever it is checked out: no build-machine paths in the WebAssembly
  (`--remap-path-prefix` for the transport, libsignal and the tokenizer),
  the build date taken from the commit (`SOURCE_DATE_EPOCH` overrides it),
  sorted file lists. Identical output across machines also needs the same
  tools: the Rust toolchains pinned in the `rust-toolchain` files,
  wasm-pack 0.15.0, binaryen 132, node 24 and the lockfiles (the
  deployment workflow pins these), and the same clang build for ring's C
  code in the transport (the workflow uses Ubuntu 24.04's `clang-18`
  package; another clang build changes `transport/webtor_wasm_bg.wasm`
  (clang 18.1.8 and 21.1.8 give different modules) and the files that
  carry its digest: `transport/wasm-integrity.js`, `app.js`, `index.html`,
  `sw.js`, `test/index.html`). libsignal's WebAssembly built on a NixOS machine is
  byte-identical to the deployed one.
- `scripts/verify-site.sh [URL]` downloads `URL`'s `SOURCE` and
  `SHA256SUMS`, checks every deployed file against `SHA256SUMS`, rebuilds
  that commit from source and compares; `--deployed-only` does the first
  part only (the deployment workflow runs it after every deployment).

## Network

libsignal-net (chat, CDSI, SVR, registration, key transparency) is not in
the WebAssembly build; `net/` implements the part of libsignal's `Net`
Desktop uses, with libsignal's TypeScript types and its semantics (paths,
headers, timeouts and error codes from libsignal-net's Rust code):

- One Tor client per page (`net/tor.ts`), bootstrapped when the app starts
  (`renderer/entry.ts`). Each Signal connection is its own Tor stream with
  TLS 1.3 (rustls, in the transport's Rust code) trusting only Signal's CA
  (the CDNs included: they use certificates from Signal's CA too).
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
- Circuits: chat connections (lane 0) have a circuit of their own, never
  shared with HTTPS requests (lane 1) or the other circuits of a parallel
  download (lanes 2-4), so a download does not delay messages. A lane keeps
  its circuit while it works (and for at most an hour of new connections);
  a spare circuit is kept ready, so a lane that needs a new one rarely
  waits for a build. A build that takes more than three times the median
  of recent builds (at least 3 s) is given up and built again through
  other relays, as Tor's circuit build timeout does; a connection that does
  not open within 10 s is tried once more on another circuit, as Tor does.
  Relays are extended to with ntor v3 and their real protocol lists, which
  negotiates congestion control (Vegas, what the consensus asks for:
  `cc_alg=2`) with every relay that supports it; others use Tor's fixed
  window. Vegas comes from Arti (`tor-proto`'s `flowctl-cc` feature,
  marked experimental there; the circuit parameters are mapped from the
  consensus as Arti's circuit manager does).
- Downloads from Signal's CDNs (attachments, stickers, avatars, the link
  archive) go in parallel byte ranges over up to 4 circuits
  (`transport/src/ranged.js`), delivered to Desktop as the one response it
  asked for (status, length, its own Range when it resumes); at most 8 MiB
  is buffered ahead of what Desktop has read. Later ranges carry If-Range
  (the first response's ETag): a file that changed fails instead of
  mixing versions, and Desktop's own size, digest and MAC checks run as
  before. A range that fails is fetched again from where it stopped (up to
  3 times), so a dropped connection costs seconds instead of Desktop's
  30 s retry. Circuits differ a lot in speed: a lane that has nothing to do
  takes over the part of a slow lane's range the reader waits for (cut
  where both finish together), and a lane three times slower than the best
  gets a new circuit. Servers that do not answer ranges are used as they
  answer. Four circuits at most: Snowflake is capacity donated for people
  in censored places.
- The Snowflake session layers use the Snowflake client's own KCP window
  (65535 segments; it was 128, about 176 KB in flight per round trip to
  the bridge); the SMUX window (4 MiB) bounds what is in flight.
- Liveness: a connection that silently stops delivering (no close, no
  error) is noticed at two levels. The Snowflake bridge sends a keepalive
  every 10 s (SMUX NOP); when nothing at all has come from it for 25 s
  (checked every 5 s; a check that ran late because the page was
  suspended gives it 15 s more) webtor closes the channel, the app's
  carrier sees that at once (`waitForChannelClose`), replaces the Tor
  client and interrupts every connection on it, so all of them reconnect
  together: about 25-30 s after the last byte, against 60 s before. An idle
  connection that works is never dropped (the bridge keeps sending). A
  single stalled circuit (the bridge still heard from) is noticed by the
  chat connection itself (libsignal's 45 s without anything from the
  server, or Desktop's keepalive request every 30 s) and gets a new circuit
  at once. Shorter chat-level bounds would drop working connections over
  slow circuits: a WebSocket ping waits behind a large upload in the same
  stream (a 256 KB request can take 20 s over Tor). Registration requests
  (linking, uploading the device's keys) are retried across reconnects for
  up to 3 minutes (`ts/textsecure/registrationRetry.web.ts`; Desktop
  retries 3 times, 1 s apart).
- Not available yet, rejecting with typed libsignal errors: CDSI (needs SGX
  attestation), SVR2, registration, key transparency, backups.
- The User-Agent is `unofficial-web-client/<version> (receiver)`.
- The Tor directory (which relays exist, their keys) is verified before
  any relay from it is used, as Tor and Arti do (webtor-rs
  `webtor/src/directory.rs`, on Arti's `tor-netdoc`, `tor-netdir` and
  `tor-dircommon`): the directory authorities' key certificates must be
  signed by the authority identities pinned in the code (Arti's list) and
  be within their lifetime; the consensus must be signed by more than half
  of those authorities and be valid now, with Tor's tolerance (one day
  early, three days late); a microdescriptor is used only if its digest is
  listed in the signed consensus, and they must cover enough of the network
  to build paths. Circuits then pick their middle and exit relays with
  Arti's relay selection (bandwidth-weighted, exit allowing port 443,
  Stable relays, no two in the same family or /16). The directory comes
  from the snapshot served with the site (`transport/tor/`: consensus,
  authority certificates, every relay's microdescriptor; fetched at build
  time by `transport/webtor-rs/scripts/fetch-consensus.sh` and verified by
  `transport/verify-directory.mjs`, so a build with a bad snapshot fails).
  If the snapshot is missing, too old or does not verify, the client
  fetches the documents through the bridge (BEGIN_DIR, a stage with its
  own time limit of 120 s, so a slow bridge is not given up on while it is
  sending them) and verifies those;
  a directory that does not verify is never used, and the shell shows
  "The list of Tor relays could not be verified" (or asks to correct the
  device's clock when even a fresh one is not valid at its time) while it
  keeps retrying.
- The carrier under TLS is an interface (`Carrier` in `net/tor.ts`, the
  `Carrier` enum in webtor-rs `signal_socket.rs`), chosen at build time in
  `net/carrier.ts`: Tor in every deployed build; the end-to-end tests'
  build replaces the module (see "End-to-end tests").
- The chat server's host and its trust root come from the app's config
  (`serverUrl`, `certificateAuthority`), as for Desktop: Signal's in
  production builds.

