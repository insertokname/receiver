<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# receiver

**receiver is Signal Desktop running in your browser, as a static website.**
Open https://receiver.insertokname.com/, scan the code with Signal on
your phone, and message from any computer, like WhatsApp Web. Nothing to
install, no account besides your Signal account.

It is a fork of [Signal Desktop](https://github.com/signalapp/Signal-Desktop).

## How it works

- **Signal Desktop's own code.** The app is Signal Desktop's renderer (its
  React UI, message handling, storage code and database migrations), built
  for the browser instead of Electron. The parts Electron provides (the main
  process, file system, native modules) are replaced by small web
  equivalents in [`web/`](web/README.md).
- **It links to your phone like Signal Desktop.** It is a linked device of
  your Signal account: scan its QR code from Signal on your phone
  (Settings > Linked devices). Message history can come along when linking
  (Signal's "transfer message history").
- **It reaches Signal through Tor.** Signal's servers don't accept
  connections from web pages (they require a TLS client and WebSocket
  headers a browser can't send, and allow no cross-origin requests), and a
  static site has no server of its own to relay through. So the app runs a
  Tor client in the page ([webtor-rs](https://github.com/insertokname/webtor-rs),
  compiled to WebAssembly) and enters the Tor network through
  [Snowflake](https://snowflake.torproject.org/) (a WebSocket bridge, with
  Snowflake's WebRTC proxies as the fallback). The page talks directly only
  to its own site and to those Tor entry points.
- **Encrypted end to end to Signal, inside Tor.** Every connection to a
  Signal server is TLS 1.3 (rustls, in WebAssembly) that trusts only
  Signal's own certificate authority, the same pin Signal Desktop uses,
  carried over Tor. Tor relays see only TLS ciphertext; Signal's server
  does not see your IP address.
- **Signal's cryptography is libsignal.** The Signal protocol, sealed
  sender, groups (zkgroup) and backups come from
  [libsignal](https://github.com/signalapp/libsignal), the same version
  Signal Desktop uses, compiled to WebAssembly; nothing is reimplemented.
- **Encrypted local storage.** Messages are kept in your browser in
  Desktop's SQLite database, encrypted (SQLCipher format) in the browser's
  private file system; the database key is wrapped by a non-extractable
  WebCrypto key. Attachments are encrypted per file, as in Desktop.
- **Static.** The site is plain files on GitHub Pages, built and deployed by
  [a workflow](.github/workflows/web-pages.yml). There is no server,
  proxy or relay of ours, no analytics, nothing loaded from third parties.
- **Like WhatsApp Web.** One window at a time ("Use here"), notifications
  while the tab is open, works offline as an app shell, installable as an
  app, a new version only after you click "reload".

### Limitations

- **Notifications only while the tab (or the installed app) is open**, also
  in the background. Signal's servers don't send web push to linked
  devices, so a closed tab can't be woken up.
- **No calls yet** (voice and video need Signal's calling library, RingRTC,
  ported to the browser).
- **Finding contacts by phone number is not available yet** (Signal's
  contact discovery needs an SGX-attested connection that is not ported).
  Contacts from your phone, usernames and groups work.
- Not finished yet either: attachments (images, files, voice notes), Signal
  backups, registering a new account (link to a phone instead), link
  previews, sticker downloads, the debug log viewer.
- **Safari** deletes a website's storage after 7 days without use unless it
  is added to the Dock or the Home Screen; the app reminds you. Other
  browsers are asked to keep the storage when you link.
- Connecting through Tor takes a few seconds (up to a minute on networks
  that block the WebSocket bridge) and adds latency. Signal can rate-limit
  or block Tor exit addresses.
- Tested with Chromium; Firefox and Safari are not tested yet.

### The web delivery trust model

Signal itself ships only installed apps, on purpose. A website is
downloaded again whenever it is opened, so whoever controls the site (here:
this repository's owner, GitHub, or someone who can compel or compromise
them) could serve different code to one person at one moment, and nobody
would notice. End-to-end encryption assumes the code at the ends is
trustworthy; an installed, signed, versioned app is much harder to swap
silently than a web page. (Signal Desktop started as a packaged Chrome app,
not a hosted page, for this reason.)

What receiver does about it, and what that does not solve:

- **The app's code is pinned by a service worker.** After the first visit
  the app loads from the browser's cache, every file checked against its
  SHA-256 digest. A new version is downloaded in the background and only
  used after you click "A new version of receiver is available". So the
  code can't change under an open session or between visits without you
  being asked. It does not protect the **first** visit, and the browser
  itself keeps the service worker script up to date: a malicious
  deployment could ship a service worker that skips the prompt.
- **Builds are deterministic and public.** The site is built from this
  repository by GitHub Actions; the same commit gives the same files (the
  build id is a digest of all of them, logged in the browser's console), so
  anyone can rebuild and compare. Nothing checks this automatically for
  you yet (there is no equivalent of Meta's Code Verify extension).
- **Strict content security policy and subresource integrity**: only the
  site's own scripts run, WebAssembly is checked against digests, and the
  page can't connect anywhere but its site and Tor's entry points.
- **Tor sees only ciphertext**, and the Tor client is not trusted with
  anything else; it affects availability and metadata, not content. The
  WebAssembly Tor client is young and unaudited, and the directory consensus
  it uses is not yet signature-checked.

If your threat model includes the site's operator or GitHub, use Signal's
own apps.

## Quick start

1. Open https://receiver.insertokname.com/ (Chromium-based browsers
   offer "Install receiver as an app"; on Safari, add it to the Dock or Home
   Screen).
2. Wait for "Connecting..." to finish, then scan the QR code with Signal on
   your phone: Settings > Linked devices > Link new device.
3. Optionally turn on desktop notifications from the banner in the chat list.

To unlink, remove the device from Linked devices on your phone; to remove
the data from the browser, delete all data in the app's settings or clear
the site's data.

## Development

Everything specific to the web build lives in [`web/`](web/README.md): the
Tor transport, libsignal's WebAssembly build, the browser build of Desktop's
renderer, the in-page replacement of Electron's main process, the SQL
worker, the networking layer, the app shell (service worker, "Use here",
connection status, banners) and the tests (including end-to-end tests
against Desktop's mock server). See [web/README.md](web/README.md) for
building and testing. The rest of the repository is Signal Desktop, kept as
close to upstream as possible: web replacements are new files (`*.web.ts`
next to the module they replace), not edits.

## Merging upstream

receiver follows Signal Desktop's **releases** (stable tags `vX.Y.Z`),
never Signal's `main`. Once a week the workflow *Web upstream* checks for a
release newer than the one receiver is based on (the version in
`package.json`) and fails, with its name, when there is one. Then:

```bash
bash web/scripts/merge-upstream.sh            # or: merge-upstream.sh v<version>
```

merges the release on a branch `upstream/v<version>`, pushes it, opens a
pull request and starts the build and tests on that branch (*Web (GitHub
Pages)* deploys only `main`). After conflicts: resolve them, `git commit`,
then `merge-upstream.sh --finish`. Merge the pull request once the checks
pass. `.github/` is receiver's own; Signal's workflows and templates are
left out of every merge.

When the release changes the libsignal version Desktop pins
(`@signalapp/libsignal-client` in `package.json`; the pull request says so),
update the libsignal fork too:
[insertokname/libsignal](https://github.com/insertokname/libsignal), branch
`web-wasm`, rebased onto the new libsignal tag, then the submodule
`web/libsignal/libsignal` on the same branch. The Tor client is the
submodule `web/transport/webtor-rs`
([insertokname/webtor-rs](https://github.com/insertokname/webtor-rs), branch
`signal-web-transport`), which merges upstream webtor-rs the same way.

## License

receiver is a modified version of Signal Desktop, Copyright 2013-2024
Signal Messenger, LLC, licensed under the GNU AGPLv3
(https://www.gnu.org/licenses/agpl-3.0.html). receiver's changes are under
the same license. As the AGPL requires for software used over a network,
the app links to this source code.

### Cryptography notice

This distribution includes cryptographic software. The country in which you
currently reside may have restrictions on the import, possession, use,
and/or re-export to another country, of encryption software. Before using
any encryption software, please check your country's laws, regulations and
policies concerning the import, possession, or use, and re-export of
encryption software, to see if this is permitted. See
<http://www.wassenaar.org/> for more information.
