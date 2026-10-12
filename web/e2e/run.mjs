// SPDX-License-Identifier: AGPL-3.0-only
//
// End-to-end tests of the web app against Desktop's own mock server
// (packages/mock-server), modelled on ts/test-mock/bootstrap.node.ts and its
// tests. The app is the e2e build (web/dist/app-e2e/: renderer/build.mjs
// --e2e), served like GitHub Pages serves the site, in headless Chromium.
// Its TLS connections reach the mock server through the test relay
// (web/e2e/relay.mjs); no Signal server and no real account is involved.
//
//   (a) link     the app shows a QR code; the mock primary device links
//                with the decoded URL; the app registers, uploads keys,
//                opens its authenticated socket, shows the inbox
//   (b) sync     contacts and a group from the primary arrive; a contact's
//                conversation opens
//   (c) receive  a contact's text message shows up in the conversation
//   (d) send     a text typed into Desktop's composer reaches the contact,
//                who decrypts it
//   (e) persist  after a reload the app is still linked (encrypted database
//                on OPFS), reconnects and receives again; after every
//                connection drops it reconnects by itself and receives
//   (f) use here a second window shows "open in another window"; its "Use
//                here" makes the first window close its database and show
//                the same, and the second one starts, reconnects, receives
//   (g) notifications  the in-app banner asks for permission; a message
//                while the window is not focused creates a notification;
//                clicking it (another conversation open) opens the
//                message's conversation; the debug log from Settings
//   (h) link-and-sync  the QR code's capabilities; what the app does when
//                the primary offers a transfer archive (see below)
//   (i)-(o) linking survives faults: every connection drops or stalls (stops
//                forwarding without closing, like a hung Tor circuit) at
//                the critical points of linking: while the authenticated
//                socket connects, while the app long-polls for the transfer
//                archive (with and without a transfer), during the contact
//                sync, half way through a large (32 MiB) archive download
//                (resumed with Range; download progress must advance). Each
//                ends in the inbox with contacts synced (and the history
//                imported when transferred).
//   (p)-(z) attachments (e2e/attachments.mjs): receive, view, save, send,
//                record, interrupted transfers, storage full
//   (aa)         linking survives an outage of 20 s as the keys are uploaded
//   (ab)         liveness: every connection silently stops delivering while
//                idle; the app notices, reconnects and receives
//
// Fails on CSP violations, uncaught exceptions, network destinations other
// than the page's origin and the relay, and key-like secrets in the log.
//
//   node e2e/run.mjs              (needs web/dist/app-e2e and $CHROMIUM)
//   ONLY=a,b,c node e2e/run.mjs   only these scenarios ((b)-(g) need (a))
//   BROWSER=firefox FIREFOX=<firefox> ONLY=... node e2e/run.mjs
//                                 in Firefox (WebDriver BiDi); scenarios that
//                                 need Chromium's DevTools protocol are not
//                                 available there

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE_PATH, FIREFOX, LOCAL_ORIGIN, decodeLinkQrCode, launchBrowser, serveSite, watchPage } from '../scripts/harness.mjs';
import { MOCK_HOST, MOCK_PORT, RELAY_PORT, RELAY_URL } from './config.mjs';
import { startMockServer } from './mock.mjs';
import { startRelay } from './relay.mjs';
import { runAttachmentScenarios } from './attachments.mjs';
import { loadAttachmentHelpers, loadBackupGenerator, loadDeviceNameDecryptor, loadPaddedBackupGenerator } from './backup-generator.mjs';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const REPO = join(WEB, '..');
const APP_DIR = join(WEB, 'dist/app-e2e/');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : undefined;

const QR = '.module-InstallScreenQrCodeNotScannedStep__qr-code--loaded svg';
const SECRET_PATTERNS = [/\b[0-9a-f]{64}\b/i, /PRAGMA key/i];
const STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS ?? 60_000);
// Linking with faults: a stalled connection is noticed after at most 45 s
// without data (libsignal-net's limit), then the app reconnects.
const FAULT_LINK_TIMEOUT_MS = Number(process.env.FAULT_LINK_TIMEOUT_MS ?? 150_000);
const LARGE_BACKUP_BYTES = Number(process.env.LARGE_BACKUP_BYTES ?? 32 * 1024 * 1024);
// (ab): a silently dead connection is noticed after at most 45 s without
// data (libsignal's limit; Desktop's keepalive every 30 s), then reconnecting.
const LIVENESS_BOUND_MS = Number(process.env.LIVENESS_BOUND_MS ?? 60_000);

// ts/test-mock/bootstrap.node.ts DEFAULT_REMOTE_CONFIG, without
// desktop.internalUser (the app should behave as for everyone).
const REMOTE_CONFIG = [
  ['desktop.senderKey.retry', { enabled: true }],
  ['global.backups.mediaTierFallbackCdnNumber', { enabled: true, value: '3' }],
  ['global.groupsv2.groupSizeHardLimit', { enabled: true, value: '64' }],
  ['global.groupsv2.maxGroupSize', { enabled: true, value: '32' }],
  ['global.pinnedChatLimit', { enabled: true, value: '4' }],
];

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s: ${what}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const results = [];
const problems = [];
let current;

async function scenario(id, name, fn) {
  if (ONLY && !ONLY.has(id)) return false;
  const started = Date.now();
  current = id;
  console.log(`\n=== (${id}) ${name}`);
  try {
    const note = await fn();
    const seconds = (Date.now() - started) / 1000;
    results.push({ id, name, ok: true, seconds, note });
    console.log(`=== (${id}) PASS in ${seconds.toFixed(1)} s${note ? `: ${note}` : ''}`);
    return true;
  } catch (error) {
    const seconds = (Date.now() - started) / 1000;
    results.push({ id, name, ok: false, seconds, note: error.message });
    console.log(`=== (${id}) FAIL after ${seconds.toFixed(1)} s: ${error.stack ?? error.message}`);
    throw error;
  }
}

// Faults for (i)-(o): rules matched against every request the mock server
// sees; `run` acts on the relay (drop, stall) or the mock.
let faultRules = [];
const faultLog = [];
const mockListeners = new Set();
function onMockEvent(event) {
  for (const listener of mockListeners) listener(event);
  for (const rule of faultRules) {
    if (!rule.match(event)) continue;
    rule.seen = (rule.seen ?? 0) + 1;
    if (rule.seen <= (rule.skip ?? 0) || rule.seen > (rule.skip ?? 0) + (rule.times ?? 1)) continue;
    const what = `${rule.name} (${event.type} ${event.method} ${event.path.replace(/\/[0-9a-f-]{20,}.*$/i, '/…')}, #${rule.seen})`;
    setTimeout(() => {
      faultLog.push(what);
      console.log(`fault: ${what}`);
      rule.run(event, rule.seen);
    }, rule.delayMs ?? 0);
  }
}

const tmp = await mkdtemp(join(os.tmpdir(), 'receiver-e2e-'));
const linkedDeviceNames = [];
const profileAvatars = new Map();
const { server, port: mockPort, mock } = await startMockServer({
  profileAvatars,
  onDeviceLink: attributes => linkedDeviceNames.push(attributes?.name),
  onEvent: onMockEvent,
  maxStorageReadKeys: 2500,
  cdn3Path: join(tmp, 'cdn3'),
  updates2Path: join(REPO, 'ts/test-mock/updates-data'),
});
console.log(`mock server on 127.0.0.1:${mockPort}`);
for (const [key, value] of REMOTE_CONFIG) server.setRemoteConfig(key, value);

const relay = await startRelay({
  port: RELAY_PORT,
  origin: LOCAL_ORIGIN,
  targets: [`${MOCK_HOST}:${MOCK_PORT}`, `${MOCK_HOST}:${mockPort}`],
  mockPort,
});
console.log(`relay on ${RELAY_URL}`);

// Local URLs (attachments) are answered by the service worker and the
// page; any that reaches the site's server is a failure (and a leak).
const localUrlsOnServer = [];
const site = await serveSite({
  siteDir: APP_DIR,
  onRequest: pathname => {
    if (pathname.startsWith(`${BASE_PATH}attachment/`)) localUrlsOnServer.push(pathname);
  },
});
// A fake microphone (a tone) for recording voice notes; its permission
// prompt is answered "allow" when the app asks (scenario (y)).
if (FIREFOX) process.env.FIREFOX_DOWNLOAD_DIR ??= await mkdtemp(join(tmp, 'firefox-downloads-'));
const browser = await launchBrowser({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  // A known storage limit for (z): 4 GiB in all, so about 800 MiB per site.
  firefoxPrefs: { 'dom.quotaManager.temporaryStorage.fixedLimit': 4 * 1024 * 1024 },
});

const logLines = [];
const pageErrors = [];
// The service worker's console (e.g. local requests it could not answer).
browser.on('targetcreated', async target => {
  if (target.type() !== 'service_worker') return;
  const worker = await target.worker().catch(() => undefined);
  worker?.on('console', m => {
    const text = `[sw] ${m.text()}`;
    logLines.push(text);
    if (process.env.VERBOSE) console.log(`  | ${text.slice(0, 300)}`);
  });
});
let page;
const watchers = [];

/** Opens a page in `context` (a fresh browser profile: its own storage). */
async function openPage(context = browser.defaultBrowserContext()) {
  page = await context.newPage();
  // The relay.
  watchers.push(await watchPage(page, { allowedOrigins: [new URL(RELAY_URL).origin] }));
  const quiet = /\[updateSchema\(\d+\)\] success$/;
  page.on('console', m => {
    const text = m.text();
    logLines.push(text);
    if (!quiet.test(text) && process.env.VERBOSE) console.log(`  | ${text.slice(0, 300)}`);
    else if (/\b(ERROR|error|Error)\b/.test(text) && !quiet.test(text)) console.log(`  | ${text.slice(0, 300)}`);
  });
  page.on('pageerror', e => {
    pageErrors.push(e.message);
    console.log(`  PAGEERROR ${e.message}`);
  });
}

const appUrl = `${LOCAL_ORIGIN}${BASE_PATH}`;

// The primary device ("Myself") and its contacts, as the bootstrap creates them.
const contactNames = ['Alice Smith', 'Bob Brown', 'Charlie Jones'];
const contacts = [];
for (const profileName of contactNames) {
  // eslint-disable-next-line no-await-in-loop
  contacts.push(await server.createPrimaryDevice({ profileName }));
}
const [alice, bob] = contacts;
// Bob has a profile picture (scenario (u)).
const bobAvatar = await readFile(join(REPO, 'fixtures/kitten-1-64-64.jpg'));
{
  const { encryptProfile } = await loadAttachmentHelpers();
  profileAvatars.set(bob.device.aci, {
    path: `profiles/${bob.device.aci.slice(0, 8)}avatar`,
    data: Buffer.from(encryptProfile(new Uint8Array(bobAvatar), bob.profileKey.serialize())),
  });
}
await server.createSecondaryDevice(alice);
const phone = await server.createPrimaryDevice({ profileName: 'Myself', contacts, hasE164: true });

// Storage service: contacts (whitelisted, Alice pinned) and a group with
// Alice and Bob, pinned (ts/test-mock/helpers.node.ts createGroup).
const GROUP_TITLE = 'Weekend plans';
const group = await phone.createGroup({ title: GROUP_TITLE, members: [phone, alice, bob] });

function accountStorageState(primary) {
  return mock.StorageState.getEmpty().updateAccount({
    profileKey: primary.profileKey.serialize(),
    givenName: primary.profileName,
    // Like a phone that has been in use: no onboarding story to download
    // (the mock server has none).
    hasViewedOnboardingStory: true,
  });
}

{
  let state = accountStorageState(phone);
  for (const contact of contacts) {
    state = state.addContact(contact, {
      whitelisted: true,
      e164: contact.device.number,
      identityKey: contact.publicKey.serialize(),
      profileKey: contact.profileKey.serialize(),
      givenName: contact.profileName,
    });
  }
  state = state.addGroup(group, { whitelisted: true }).pinGroup(group).pin(alice);
  await phone.setStorageState(state);
}

let desktop;
let linkCapabilities = '';
let ok = false;

async function waitForSelector(selector, what, timeout = STEP_TIMEOUT_MS) {
  try {
    return await page.waitForSelector(selector, { timeout });
  } catch {
    throw new Error(`timed out after ${timeout / 1000} s waiting for ${what} (${selector})`);
  }
}

async function clearInput(selector) {
  await page.focus(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
}

async function openConversation(contact) {
  await waitForSelector(`#LeftPane [data-testid="${contact.device.aci}"]`, `${contact.profileName} in the conversation list`);
  await page.click(`#LeftPane [data-testid="${contact.device.aci}"]`);
  await waitForSelector('.module-ConversationHeader', 'the conversation header');
}

async function waitForTimelineText(text, what) {
  await page
    .waitForFunction(
      t =>
        [...document.querySelectorAll('.module-timeline__messages__container .module-message__text')].some(e =>
          e.textContent.includes(t)
        ),
      { timeout: STEP_TIMEOUT_MS },
      text
    )
    .catch(() => {
      throw new Error(`timed out waiting for ${what} in the timeline`);
    });
}


/**
 * Opens the debug log view with `open()`, saves the log to a file through
 * the view's "Save as file" and checks it: log lines, no key-like strings,
 * none of `secrets` (ids and numbers the log must not show in full).
 */
async function checkDebugLog(open, secrets) {
  // Firefox saves downloads to the directory set at launch (harness.mjs).
  const dir = FIREFOX ? process.env.FIREFOX_DOWNLOAD_DIR : await mkdtemp(join(tmp, 'download-'));
  const before = new Set(await readdir(dir));
  const cdp = FIREFOX ? undefined : await page.createCDPSession();
  await cdp?.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
  await open();
  await waitForSelector('[data-web-dialog="debug-log"] [data-testid="debug-log-save"]:not([disabled])', 'the debug log view, loaded');
  const shown = await page.$eval('[data-testid="debug-log-text"]', e => e.value);
  await page.click('[data-testid="debug-log-save"]');
  let file;
  for (let i = 0; i < 100 && !file; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 100));
    // eslint-disable-next-line no-await-in-loop
    const names = await readdir(dir);
    // Firefox writes <name>.part first.
    if (!names.some(name => name.endsWith('.part'))) {
      file = names.find(name => !before.has(name) && /^receiver-debug-log-.*\.txt$/.test(name));
    }
  }
  if (!file) throw new Error('"Save as file" saved no file');
  const saved = await readFile(join(dir, file), 'utf8');
  await page.click('[data-testid="debug-log-close"]');
  await cdp?.detach();
  if (saved !== shown) throw new Error('the saved debug log differs from the one shown');
  if (!/========= System info =========/.test(saved) || !/========= Logs =========/.test(saved)) {
    throw new Error('the debug log has no header or log section');
  }
  const lines = saved.split('\n').length;
  if (lines < 50) throw new Error(`the debug log has only ${lines} lines`);
  const leaked = [
    ...SECRET_PATTERNS.filter(p => p.test(saved)).map(String),
    ...secrets.filter(secret => secret && saved.includes(secret)).map(secret => `${secret.slice(0, 4)}...`),
  ];
  if (leaked.length) throw new Error(`the debug log contains secret-looking strings: ${leaked.join(', ')}`);
  return `${lines} lines, ${(saved.length / 1024).toFixed(0)} KiB saved as ${file}; no secret-looking strings`;
}

const isTransferArchivePoll = e => e.type === 'ws' && e.method === 'GET' && e.path.startsWith('/v1/devices/transfer_archive');
const isAuthUpgrade = e => e.type === 'upgrade' && e.authenticated;
const isProfileFetch = e => e.type === 'ws' && e.method === 'GET' && e.path.startsWith('/v1/profile/');

/**
 * Links a new primary device ("phone") in a fresh browser profile while
 * `rules` inject faults, and waits until the app shows the inbox with
 * the contact sync done (and, with a transfer, the history imported).
 *
 *   transfer 'none'      the phone does not offer its history
 *            'archive'   it uploads an ephemeral backup (`backupBytes`
 *                        large); the mock answers the app's long poll on
 *                        `answerOnPoll` (1: the first poll, 2: the poll
 *                        after a fault, ...)
 *            'continue'  it offers, then continues without a transfer
 *
 * Contacts must be synced and messages processed within `maxSeconds` of
 * linking (a stalled connection takes up to 45 s to notice).
 */
async function linkWithFaults({ name, transfer = 'none', answerOnPoll = 1, backupBytes, rules = [], beforeLink, maxSeconds = 60 }) {
  const { randomBytes } = await import('node:crypto');
  // Only the linking app's traffic: the faults must hit it alone.
  for (const other of await browser.pages()) {
    // eslint-disable-next-line no-await-in-loop
    await other.close().catch(() => undefined);
  }
  const primary = await server.createPrimaryDevice({ profileName: name, contacts: [alice, bob], hasE164: true });
  // Contacts come only from the contact sync (the storage service has the
  // account record alone): finding them proves the sync worked.
  await primary.setStorageState(accountStorageState(primary));

  let answer;
  let backupSize = 0;
  const historyAcis = [crypto.randomUUID(), crypto.randomUUID()];
  if (transfer !== 'none') {
    primary.ephemeralBackupKey = randomBytes(32);
  }
  if (transfer === 'archive') {
    const options = {
      aci: primary.device.aci,
      profileKey: primary.profileKey.serialize(),
      mediaRootBackupKey: primary.mediaRootBackupKey,
      backupKey: primary.ephemeralBackupKey,
      conversations: 2,
      conversationAcis: historyAcis,
      messages: 50,
    };
    let stream;
    if (backupBytes) {
      const { generatePaddedBackup } = await loadPaddedBackupGenerator();
      ({ stream, size: backupSize } = await generatePaddedBackup(options, backupBytes));
    } else {
      const { generateBackup } = await loadBackupGenerator();
      ({ stream } = generateBackup(options));
    }
    const cdnKey = randomBytes(16).toString('hex');
    await server.storeAttachmentOnCdn(3, cdnKey, stream);
    answer = { cdn: 3, key: cdnKey };
  } else if (transfer === 'continue') {
    answer = { error: 'CONTINUE_WITHOUT_UPLOAD' };
  }

  let device;
  let polls = 0;
  const contactsKey = primary.getContactsBlob().attachmentIdentifier?.cdnKey;
  const context = { primary, contactsKey, isContactsDownload: e => e.type === 'http' && e.path.startsWith('/attachments/') && e.path.includes(contactsKey) };
  faultRules = [
    ...(answer
      ? [
          {
            name: 'transfer archive answer',
            times: Infinity,
            match: isTransferArchivePoll,
            run: () => {
              polls += 1;
              if (polls !== answerOnPoll) return;
              void (async () => {
                while (!device) await new Promise(resolve => setTimeout(resolve, 50));
                await server.provideTransferArchive(device, answer);
              })();
            },
          },
        ]
      : []),
    ...rules.map(rule => (typeof rule === 'function' ? rule(context) : rule)),
  ];
  const faultsBefore = faultLog.length;

  await openPage(await browser.createBrowserContext());
  await beforeLink?.(page);
  const provisioning = server.waitForProvision();
  const started = Date.now();
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await waitForSelector(QR, 'the link QR code', 120_000);
  const qr = await decodeLinkQrCode(page, QR);
  if (!qr.ok) throw new Error(`QR code: ${qr.reason}`);
  const provision = await withTimeout(provisioning, STEP_TIMEOUT_MS, 'the provisioning socket at the mock');
  device = await withTimeout(
    provision.complete({ provisionURL: qr.url, primaryDevice: primary }),
    STEP_TIMEOUT_MS,
    'the app to register the linked device'
  );
  const linked = Date.now();
  await primary.addSingleUseKey(device, await withTimeout(device.popSingleUseKey(), FAULT_LINK_TIMEOUT_MS, 'keys'));
  await withTimeout(primary.waitForSync(device), FAULT_LINK_TIMEOUT_MS, 'the initial sync requests');
  primary.resetSyncState(device);

  try {
    await page.waitForSelector('#LeftPane', { timeout: Math.max(1000, FAULT_LINK_TIMEOUT_MS - (Date.now() - linked)) });
  } catch {
    const state = await page.evaluate(() => JSON.stringify(window.reduxStore?.getState().installer)).catch(() => '?');
    throw new Error(`no inbox ${((Date.now() - linked) / 1000).toFixed(0)} s after linking; installer state ${state}`);
  }
  const inboxSeconds = (Date.now() - linked) / 1000;
  if (await page.$('[class*="module-InstallScreen"]')) throw new Error('the install screen is still shown');

  // The contact sync: Bob is known (he has no conversation yet: search).
  // The inbox can open before the sync is done (Desktop opens it when the
  // connection drops) and search results do not follow new contacts: search
  // again until he is found.
  const search = '.module-SearchInput__input.LeftPaneSearchInput__input';
  const bobResult = `#LeftPane [data-testid="${bob.device.aci}"]`;
  const searchDeadline = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await waitForSelector(search, 'the search box');
    // eslint-disable-next-line no-await-in-loop
    await clearInput(search);
    // eslint-disable-next-line no-await-in-loop
    await page.type(search, 'Bob');
    // eslint-disable-next-line no-await-in-loop
    if (await page.waitForSelector(bobResult, { timeout: 3000 }).then(() => true, () => false)) break;
    if (Date.now() > searchDeadline) throw new Error('timed out waiting for Bob (from the contact sync) in the search results');
  }
  await clearInput(search);

  // Messages are processed: one from Alice shows up in the conversation list.
  await alice.addSingleUseKey(device, await device.popSingleUseKey(mock.ServiceIdKind.ACI), mock.ServiceIdKind.ACI);
  const hello = `Hello ${name} ${Date.now()}`;
  await alice.sendText(device, hello);
  await page
    .waitForFunction(
      ([id, text]) => document.querySelector(`#LeftPane [data-testid="${id}"]`)?.textContent.includes(text),
      { timeout: STEP_TIMEOUT_MS },
      [alice.device.aci, hello]
    )
    .catch(() => {
      throw new Error("timed out waiting for Alice's message in the conversation list (messages not processed)");
    });
  const doneSeconds = (Date.now() - linked) / 1000;
  if (doneSeconds > maxSeconds) {
    throw new Error(`contacts synced and messages processed only ${doneSeconds.toFixed(1)} s after linking (bound ${maxSeconds} s)`);
  }

  if (transfer === 'archive') {
    await page
      .waitForFunction(
        ([first, second]) => {
          const text = id => document.querySelector(`#LeftPane [data-testid="${id}"]`)?.textContent ?? '';
          return text(first).includes('Message 48') && text(second).includes('Message 49');
        },
        { timeout: STEP_TIMEOUT_MS },
        historyAcis
      )
      .catch(() => {
        throw new Error('timed out waiting for the imported conversations ("Message 48", "Message 49")');
      });
  }
  faultRules = [];
  const faults = faultLog.slice(faultsBefore);
  if (rules.length && !faults.some(f => !f.startsWith('transfer archive answer'))) {
    throw new Error('no fault was injected');
  }
  return {
    primary,
    device,
    backupSize,
    polls,
    summary: `inbox ${inboxSeconds.toFixed(1)} s, contacts synced and a message received ${doneSeconds.toFixed(1)} s after linking (link ${((linked - started) / 1000).toFixed(1)} s after load); faults: ${faults.filter(f => !f.startsWith('transfer archive answer')).join('; ')}${answer ? `; ${polls} transfer archive polls` : ''}`,
  };
}

const dropAll = { name: 'drop all connections', run: () => relay.dropAll() };
// As a Tor client being replaced: no new connection works for a while.
const dropAllFor = ms => ({
  name: `drop all connections, refuse new ones for ${ms / 1000} s`,
  run: () => {
    relay.refuseFor(ms);
    relay.dropAll();
  },
});
const stallAll = { name: 'stall all connections', run: () => relay.stallAll() };

try {
  await openPage();

  await scenario('a', 'link: QR code, device registered, keys uploaded, authenticated socket, inbox', async () => {
    const provisioning = server.waitForProvision();
    const response = await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    if (!response?.ok()) throw new Error(`page load failed: HTTP ${response?.status()}`);
    const loaded = Date.now();
    await waitForSelector(QR, 'the link QR code', 120_000);
    const qrSeconds = (Date.now() - loaded) / 1000;
    const qr = await decodeLinkQrCode(page, QR);
    if (!qr.ok) throw new Error(`QR code: ${qr.reason}`);
    console.log(`QR code after ${qrSeconds.toFixed(1)} s: ${qr.summary}`);
    // Persistent storage is asked for after linking, not on a first visit.
    if (await page.evaluate(() => window.__webPersist != null)) throw new Error('persistent storage was asked for before linking');
    linkCapabilities = new URL(qr.url).searchParams.get('capabilities') ?? '';
    const linkScreenLog = await checkDebugLog(async () => {
      await waitForSelector('[data-testid="debug-log-link"]', 'the "Problems linking?" link');
      await page.click('[data-testid="debug-log-link"]');
    }, []);
    console.log(`debug log from the link screen: ${linkScreenLog}`);

    const provision = await withTimeout(provisioning, STEP_TIMEOUT_MS, 'the provisioning socket at the mock');
    desktop = await withTimeout(
      provision.complete({ provisionURL: qr.url, primaryDevice: phone }),
      STEP_TIMEOUT_MS,
      'the app to register the linked device'
    );
    console.log(`linked: device ${desktop.debugId}`);

    // As Bootstrap.link(): the phone and the contacts start sessions with
    // the new device using its uploaded one-time keys.
    const desktopKey = await withTimeout(desktop.popSingleUseKey(), STEP_TIMEOUT_MS, 'the app to upload its keys');
    await phone.addSingleUseKey(desktop, desktopKey);
    for (const contact of contacts) {
      // eslint-disable-next-line no-await-in-loop
      await contact.addSingleUseKey(desktop, await desktop.popSingleUseKey(mock.ServiceIdKind.ACI), mock.ServiceIdKind.ACI);
      if (desktop.pni) {
        // eslint-disable-next-line no-await-in-loop
        await contact.addSingleUseKey(desktop, await desktop.popSingleUseKey(mock.ServiceIdKind.PNI), mock.ServiceIdKind.PNI);
      }
    }
    await withTimeout(phone.waitForSync(desktop), STEP_TIMEOUT_MS, 'the initial sync requests (contacts, blocked, keys, configuration)');
    phone.resetSyncState(desktop);

    if (!server.webSockets.get(desktop)) throw new Error('no authenticated socket for the linked device at the mock');

    // The device name the phone shows (encrypted to the account's identity
    // key): the browser's, like WhatsApp Web's.
    const { decryptLinkedDeviceName } = await loadDeviceNameDecryptor();
    const encryptedName = linkedDeviceNames.at(-1);
    if (!encryptedName) throw new Error('the link request had no device name');
    const linkedName = decryptLinkedDeviceName(encryptedName, phone.privateKey.serialize());
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const expectedPlatform = /Macintosh/.test(userAgent) ? 'macOS' : /Windows/.test(userAgent) ? 'Windows' : 'Linux';
    if (!new RegExp(`^receiver \\(${FIREFOX ? 'Firefox' : '(Chrome|Chromium)'}, ${expectedPlatform}\\)$`).test(linkedName) || linkedName.length > 50) {
      throw new Error(`device name "${linkedName}"`);
    }
    console.log(`device name at the phone: "${linkedName}"`);
    await waitForSelector('#LeftPane', 'the inbox (left pane)');
    if (await page.$(QR)) throw new Error('the QR code is still shown');
    await page.waitForFunction(() => window.__webPersist != null, { timeout: 10_000 }).catch(() => undefined);
    const persist = await page.evaluate(() => window.__webPersist ?? null);
    if (!persist?.asked) throw new Error(`persistent storage was not asked for after linking: ${JSON.stringify(persist)}`);
    console.log(`persistent storage after linking: asked, ${persist.persisted ? 'granted' : 'not granted'}`);
    return `QR in ${qrSeconds.toFixed(1)} s (${qr.decoded ? 'decoded by jsQR' : 'jsQR could not read it, link from the QR component'}), capabilities=${linkCapabilities}, device name "${linkedName}"`;
  });

  await scenario('b', 'sync: contacts and groups arrive, a conversation opens', async () => {
    // Pinned in storage: the contact Alice and the group.
    await waitForSelector(`#LeftPane [data-testid="${alice.device.aci}"]`, 'Alice (pinned) in the conversation list');
    await page
      .waitForFunction(t => document.querySelector('#LeftPane')?.textContent.includes(t), { timeout: STEP_TIMEOUT_MS }, GROUP_TITLE)
      .catch(() => {
        throw new Error(`timed out waiting for the group "${GROUP_TITLE}" in the conversation list`);
      });
    // The other contacts have no conversation yet: search finds them.
    const search = '.module-SearchInput__input.LeftPaneSearchInput__input';
    for (const contact of contacts.slice(1)) {
      // eslint-disable-next-line no-await-in-loop
      await clearInput(search);
      // eslint-disable-next-line no-await-in-loop
      await page.type(search, contact.profileName.split(' ')[0]);
      // eslint-disable-next-line no-await-in-loop
      await waitForSelector(`#LeftPane [data-testid="${contact.device.aci}"]`, `${contact.profileName} in the search results`);
    }
    await clearInput(search);
    await openConversation(alice);
    const title = await page.$eval('.module-ConversationHeader', e => e.textContent.trim());
    if (!title.includes('Alice')) throw new Error(`conversation header is "${title}"`);
    return `pinned Alice and "${GROUP_TITLE}" listed, ${contacts.length - 1} more contacts found by search; header "${title.slice(0, 40)}"`;
  });

  await scenario('c', 'receive: a contact\'s message appears', async () => {
    const text = `Hello from Alice ${Date.now()}`;
    await alice.sendText(desktop, text);
    await waitForTimelineText(text, 'the received message');
    return `"${text}"`;
  });

  await scenario('d', 'send: typed in the composer, decrypted by the contact', async () => {
    const text = `Hello Alice, from the web ${Date.now()}`;
    const editor = await waitForSelector(
      '.Inbox__conversation [data-testid=CompositionInput][data-enabled=true] .ql-editor',
      'an enabled composer'
    );
    await editor.click();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { body, source } = await withTimeout(alice.waitForMessage(), deadline - Date.now(), 'the contact to receive the message');
      if (body === text) {
        if (source !== desktop) throw new Error(`message came from ${source?.debugId}, not the linked device`);
        break;
      }
      console.log(`contact got another message first: ${JSON.stringify(body)?.slice(0, 60)}`);
    }
    await waitForTimelineText(text, 'the sent message');
    return `contact decrypted "${text}"`;
  });

  await scenario('e', 'persistence: reload, still linked, reconnects, receives; then survives a dropped connection', async () => {
    const waitForNewSocket = async (before, what) => {
      const deadline = Date.now() + STEP_TIMEOUT_MS;
      while (!server.webSockets.get(desktop) || server.webSockets.get(desktop) === before) {
        if (Date.now() > deadline) throw new Error(`the app did not open a new authenticated socket ${what}`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    };
    const before = server.webSockets.get(desktop);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSelector('#LeftPane', 'the inbox after reload', 120_000);
    if (await page.$('[class*="module-InstallScreen"]')) throw new Error('the install screen is shown after reload');
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (await page.evaluate(() => window.__webPersist?.asked === true)) throw new Error('persistent storage was asked for again after a reload');
    await waitForNewSocket(before, 'after reload');
    const text = `Welcome back ${Date.now()}`;
    await alice.sendText(desktop, text);
    await openConversation(alice);
    await waitForTimelineText(text, 'the message received after reload');

    // Every connection drops (the relay closes them, like a network change).
    const dropped = Date.now();
    const lastSocket = server.webSockets.get(desktop);
    relay.dropAll();
    await waitForNewSocket(lastSocket, 'after the connection dropped');
    const reconnectSeconds = (Date.now() - dropped) / 1000;
    const again = `Still here ${Date.now()}`;
    await alice.sendText(desktop, again);
    await waitForTimelineText(again, 'the message received after reconnecting');
    return `"${text}"; reconnected ${reconnectSeconds.toFixed(1)} s after the drop and received "${again}"`;
  });

  // Link-and-sync: the QR code advertises `backup5`, so a phone offers to
  // send the message history (an ephemeral backup in the transit tier of
  // CDN 3) while linking; the app downloads and imports it, like WhatsApp
  // Web's history sync. As ts/test-mock/backups ("imports ephemeral
  // backup"), in a fresh browser profile with a second primary device.
  await scenario('f', 'use here: a second window takes over', async () => {
    const first = page;
    const before = server.webSockets.get(desktop);
    await openPage();
    const second = page;
    const opened = Date.now();
    await second.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await waitForSelector('[data-web-screen="open-elsewhere"] [data-testid="use-here"]', 'the "open in another window" screen');
    const screenSeconds = (Date.now() - opened) / 1000;
    const secondBoot = await second.evaluate(() => ({ boot: document.documentElement.dataset.boot, storage: window.__webStorage ?? null }));
    if (secondBoot.boot !== 'start' || secondBoot.storage) throw new Error(`the second window started anyway: ${JSON.stringify(secondBoot)}`);

    const clicked = Date.now();
    await second.click('[data-testid="use-here"]');
    await first
      .waitForSelector('[data-web-screen="open-elsewhere"]', { timeout: STEP_TIMEOUT_MS })
      .catch(() => {
        throw new Error('the first window does not show "open in another window"');
      });
    const firstState = await first.evaluate(() => ({ boot: document.documentElement.dataset.boot, storage: window.__webStorage ?? null }));
    if (firstState.boot !== 'start' || firstState.storage) throw new Error(`the first window kept running: ${JSON.stringify(firstState)}`);
    await waitForSelector('#LeftPane', 'the inbox in the second window', 120_000);
    const inboxSeconds = (Date.now() - clicked) / 1000;
    const releaseMs = await second.evaluate(() => document.documentElement.dataset.webUseHereMs);
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (!server.webSockets.get(desktop) || server.webSockets.get(desktop) === before) {
      if (Date.now() > deadline) throw new Error('the second window did not connect');
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const text = `Hello second window ${Date.now()}`;
    await alice.sendText(desktop, text);
    await openConversation(alice);
    await waitForTimelineText(text, 'the message in the second window');
    await first.close();
    return `screen after ${screenSeconds.toFixed(1)} s; after "Use here": database released in ${releaseMs} ms, inbox in ${inboxSeconds.toFixed(1)} s; received "${text}"`;
  });

  await scenario('g', 'notifications: permission banner, a notification, clicking it opens the conversation', async () => {
    const banner = '[data-web-banner="notifications"] [data-testid="notifications-turn-on"]';
    await waitForSelector(banner, 'the "Turn on desktop notifications" banner');
    const permissionBefore = await page.evaluate(() => Notification.permission);
    await browser.defaultBrowserContext().overridePermissions(LOCAL_ORIGIN, ['notifications']);
    await page.click(banner);
    await page.waitForFunction(() => !document.querySelector('[data-web-banner="notifications"]'), { timeout: 10_000 }).catch(() => {
      throw new Error('the banner stayed after permission was granted');
    });
    const permission = await page.evaluate(() => Notification.permission);
    if (permission !== 'granted') throw new Error(`permission is ${permission}`);

    // Record the notifications Desktop creates. Another conversation (the
    // group) is open: clicking the notification switches from it.
    await page.evaluate(() => {
      const Original = window.Notification;
      window.__notifications = [];
      window.Notification = class extends Original {
        constructor(title, options) {
          super(title, options);
          window.__notifications.push({ title, body: options?.body ?? '', notification: this });
        }
      };
    });
    await page.evaluate(title => {
      const { conversationLookup } = window.reduxStore.getState().conversations;
      const { id } = Object.values(conversationLookup).find(c => c.type === 'group' && c.title === title);
      window.reduxActions.conversations.showConversation({ conversationId: id });
    }, GROUP_TITLE);
    await page
      .waitForFunction(t => document.querySelector('.module-ConversationHeader')?.textContent.includes(t), { timeout: STEP_TIMEOUT_MS }, GROUP_TITLE)
      .catch(() => {
        throw new Error('the group conversation did not open');
      });
    const logLinesBefore = logLines.length;
    // The window loses focus (as when the user switches to another window).
    await page.evaluate(() => {
      document.hasFocus = () => false;
      window.dispatchEvent(new Event('blur'));
    });

    const text = `Notify me ${Date.now()}`;
    await alice.sendText(desktop, text);
    await page
      .waitForFunction(t => window.__notifications.some(n => n.body.includes(t)), { timeout: STEP_TIMEOUT_MS }, text)
      .catch(() => {
        throw new Error('no notification for the message');
      });
    const shown = await page.evaluate(t => {
      const n = window.__notifications.find(x => x.body.includes(t));
      n.notification.onclick();
      return { title: n.title, count: window.__notifications.length };
    }, text);
    await page.waitForFunction(() => document.querySelector('.module-ConversationHeader')?.textContent.includes('Alice'), { timeout: STEP_TIMEOUT_MS }).catch(() => {
      throw new Error("clicking the notification did not open Alice's conversation");
    });
    // Desktop targets the message before it changes the conversation: the
    // group's view is asked to scroll to it (logged, no longer thrown).
    const raced = logLines.slice(logLinesBefore).some(l => /scrollToMessage: .* didn't have conversationId/.test(l));
    await page.evaluate(() => {
      delete document.hasFocus;
      window.dispatchEvent(new Event('focus'));
    });
    // The debug log from the inbox: Settings > General > Debug log.
    const settingsLog = await checkDebugLog(
      async () => {
        await page.click('[data-testid="NavTabsItem--Settings"]');
        const general = await waitForSelector('::-p-xpath(//button[contains(., "General")])', 'General in Settings');
        await general.click();
        const item = await waitForSelector('::-p-xpath(//*[normalize-space(text())="Debug log"])', 'Debug log in Settings > General');
        await item.click();
      },
      [desktop.aci, desktop.pni, phone.device.aci, phone.device.number, alice.device.aci, alice.device.number, bob.device.aci]
    );
    await page.click('[data-testid="NavTabsItem--Chats"]');
    await openConversation(alice);
    return `permission ${permissionBefore} -> granted via the banner; notification "${shown.title}" for "${text}"; click opened Alice's conversation from the group's${raced ? ' (scroll request for the group seen)' : ''}; debug log from Settings > General: ${settingsLog}`;
  });

  // Every connection silently stops delivering (no close, no error), as a
  // hung Tor circuit or a black-holed bridge connection; new ones work. The
  // app must notice, reconnect, and get the message sent meanwhile.
  await scenario('ab', 'liveness: every connection black-holed while idle, the app reconnects and receives', async () => {
    const lastSocket = server.webSockets.get(desktop);
    const statuses = new Set();
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        // eslint-disable-next-line no-await-in-loop
        const status = await page.evaluate(() => window.reduxStore.getState().network.socketStatus).catch(() => undefined);
        if (status) statuses.add(status);
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    })();
    const started = Date.now();
    relay.stallAll();
    const text = `Through the outage ${Date.now()}`;
    await alice.sendText(desktop, text);
    try {
      await page
        .waitForFunction(
          t => [...document.querySelectorAll('.module-timeline__messages__container .module-message__text')].some(e => e.textContent.includes(t)),
          { timeout: LIVENESS_BOUND_MS },
          text
        )
        .catch(() => {
          throw new Error(`the message did not arrive within ${LIVENESS_BOUND_MS / 1000} s of the black hole`);
        });
    } finally {
      sampling = false;
      await sampler;
    }
    const seconds = (Date.now() - started) / 1000;
    if (server.webSockets.get(desktop) === lastSocket) throw new Error('no new authenticated socket');
    return `message received ${seconds.toFixed(1)} s after every connection was black-holed (bound ${LIVENESS_BOUND_MS / 1000} s); socket status seen: ${[...statuses].join(', ')}`;
  });

  // (p)-(w): attachments (e2e/attachments.mjs).
  await runAttachmentScenarios({
    scenario,
    server,
    mock,
    alice,
    bob,
    relay,
    REPO,
    tmp,
    STEP_TIMEOUT_MS,
    page: () => page,
    desktop: () => desktop,
    openConversation,
    waitForSelector,
    bobAvatar,
    onMockEvent: listener => mockListeners.add(listener),
  });

  await scenario('h', 'link-and-sync: history from the primary\'s ephemeral backup', async () => {
    if (!linkCapabilities.split(',').includes('backup5')) {
      return `QR capabilities ${linkCapabilities}: no link-and-sync offered`;
    }
    const { generateBackup } = await loadBackupGenerator();
    const { randomBytes } = await import('node:crypto');
    const phone2 = await server.createPrimaryDevice({ profileName: 'Second phone', contacts: [alice], hasE164: true });
    const ephemeralBackupKey = randomBytes(32);
    phone2.ephemeralBackupKey = ephemeralBackupKey;
    const historyAcis = [crypto.randomUUID(), crypto.randomUUID()];
    const cdnKey = randomBytes(16).toString('hex');
    const { stream } = generateBackup({
      aci: phone2.device.aci,
      profileKey: phone2.profileKey.serialize(),
      mediaRootBackupKey: phone2.mediaRootBackupKey,
      backupKey: ephemeralBackupKey,
      conversations: 2,
      conversationAcis: historyAcis,
      messages: 50,
    });
    await server.storeAttachmentOnCdn(3, cdnKey, stream);

    await openPage(await browser.createBrowserContext());
    const provisioning = server.waitForProvision();
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await waitForSelector(QR, 'the link QR code', 120_000);
    const qr = await decodeLinkQrCode(page, QR);
    if (!qr.ok) throw new Error(`QR code: ${qr.reason}`);
    const provision = await withTimeout(provisioning, STEP_TIMEOUT_MS, 'the provisioning socket at the mock');
    const desktop2 = await withTimeout(
      provision.complete({ provisionURL: qr.url, primaryDevice: phone2 }),
      STEP_TIMEOUT_MS,
      'the app to register the linked device'
    );
    await server.provideTransferArchive(desktop2, { cdn: 3, key: cdnKey });
    await phone2.addSingleUseKey(desktop2, await withTimeout(desktop2.popSingleUseKey(), STEP_TIMEOUT_MS, 'keys'));
    await withTimeout(phone2.waitForSync(desktop2), STEP_TIMEOUT_MS, 'the initial sync requests');
    phone2.resetSyncState(desktop2);

    // The backup's conversations and messages (generateBackup: message i
    // goes to conversation i % 2, so the last ones are 48 and 49).
    await page
      .waitForFunction(
        ([first, second]) => {
          const text = id => document.querySelector(`#LeftPane [data-testid="${id}"]`)?.textContent ?? '';
          return text(first).includes('Message 48') && text(second).includes('Message 49');
        },
        { timeout: STEP_TIMEOUT_MS },
        historyAcis
      )
      .catch(() => {
        throw new Error('timed out waiting for the imported conversations ("Message 48", "Message 49") in the conversation list');
      });
    await page.click(`#LeftPane [data-testid="${historyAcis[1]}"]`);
    await waitForTimelineText('Message 33', 'an imported message');
    return 'backup5 offered; 2 conversations and 50 messages imported from the ephemeral backup';
  });

  // The authenticated socket first carries the registration (keys upload,
  // which Desktop retries 3 times, 1 s apart); right after it, the app
  // fetches profiles (where the owner's log shows the drop).
  await scenario('i', 'link: every connection drops as the authenticated socket connects, and again (4 s outage) right after registration', async () => {
    const { summary } = await linkWithFaults({
      name: 'Phone i',
      rules: [
        { ...dropAll, match: isAuthUpgrade },
        { ...dropAllFor(4000), match: isProfileFetch },
      ],
    });
    return summary;
  });

  await scenario('j', 'link: every connection stalls right after registration', async () => {
    const { summary } = await linkWithFaults({
      name: 'Phone j',
      maxSeconds: 90,
      rules: [{ ...stallAll, match: isProfileFetch }],
    });
    return summary;
  });

  await scenario('k', 'link with transfer: every connection drops while the app long-polls for the archive', async () => {
    const { summary } = await linkWithFaults({
      name: 'Phone k',
      transfer: 'archive',
      answerOnPoll: 2,
      rules: [{ ...dropAllFor(4000), match: isTransferArchivePoll, delayMs: 500 }],
    });
    return summary;
  });

  await scenario('l', 'link, phone continues without transfer: every connection stalls during the long poll', async () => {
    const { summary } = await linkWithFaults({
      name: 'Phone l',
      maxSeconds: 90,
      transfer: 'continue',
      answerOnPoll: 2,
      rules: [{ ...stallAll, match: isTransferArchivePoll, delayMs: 500 }],
    });
    return summary;
  });

  await scenario('m', 'link without transfer: every connection drops as the phone sends the contact sync', async () => {
    const { summary } = await linkWithFaults({
      name: 'Phone m',
      rules: [{ ...dropAllFor(4000), match: e => e.type === 'push' }],
    });
    return summary;
  });

  await scenario('n', 'link without transfer: every connection stalls during the contact sync', async () => {
    const { summary } = await linkWithFaults({
      name: 'Phone n',
      maxSeconds: 90,
      rules: [({ isContactsDownload }) => ({ ...stallAll, match: isContactsDownload })],
    });
    return summary;
  });

  // Desktop retries the keys upload 3 times, 1 s apart: an outage longer
  // than that used to fail the link (the phone already shows the device).
  await scenario('aa', 'link: every connection drops as the keys upload arrives, new ones refused for 20 s', async () => {
    const { summary } = await linkWithFaults({
      name: 'Phone aa',
      maxSeconds: 90,
      rules: [{ ...dropAllFor(20_000), match: e => e.type === 'ws' && e.method === 'PUT' && e.path.startsWith('/v2/keys') }],
    });
    return summary;
  });

  await scenario('o', `link with a large archive (${(LARGE_BACKUP_BYTES / 2 ** 20).toFixed(0)} MiB): progress, a drop half way, resumed with Range`, async () => {
    const ranges = [];
    const archiveDownload = e => e.type === 'http' && e.method === 'GET' && /^\/cdn3\/attachments\//.test(e.path);
    const started = Date.now();
    const { summary, backupSize } = await linkWithFaults({
      name: 'Phone o',
      transfer: 'archive',
      backupBytes: LARGE_BACKUP_BYTES,
      rules: [
        {
          name: 'drop all connections half way through the archive download',
          match: archiveDownload,
          times: 1,
          run: () => relay.afterBytesDown(Math.floor(LARGE_BACKUP_BYTES / 2), () => relay.dropAll()),
        },
        {
          name: 'archive download',
          match: archiveDownload,
          times: Infinity,
          run: e => {
            if (e.range) ranges.push(e.range);
          },
        },
      ],
      beforeLink: p =>
        p.evaluateOnNewDocument(() => {
          window.__backupProgress = [];
          window.__heap = [];
          const timer = setInterval(() => {
            const store = window.reduxStore;
            if (!store) return;
            const { installer } = store.getState();
            if (installer?.step === 'BackupImport' && installer.backupStep === 'Download') {
              const last = window.__backupProgress.at(-1);
              if (!last || last.currentBytes !== installer.currentBytes) {
                window.__backupProgress.push({ t: Date.now(), currentBytes: installer.currentBytes, totalBytes: installer.totalBytes });
                if (performance.memory) window.__heap.push(performance.memory.usedJSHeapSize);
              }
            }
            if (store.getState().app?.appView === 'Inbox') clearInterval(timer);
          }, 50);
        }),
    });
    const { progress, heap } = await page.evaluate(() => ({ progress: window.__backupProgress, heap: window.__heap }));
    const distinct = new Set(progress.map(p => p.currentBytes)).size;
    if (distinct < 5) throw new Error(`download progress did not advance in steps: ${JSON.stringify(progress.slice(0, 10))}`);
    if (!ranges.some(r => /^bytes=[1-9]\d*-$/.test(r))) throw new Error(`the download was not resumed with a Range request: ${JSON.stringify(ranges)}`);
    const maxHeap = heap.length ? Math.max(...heap) : 0;
    const minHeap = heap.length ? Math.min(...heap) : 0;
    const total = progress.at(-1)?.totalBytes;
    const seconds = (Date.now() - started) / 1000;
    return `${(backupSize / 2 ** 20).toFixed(1)} MiB archive, total ${total}; ${progress.length} progress updates (${distinct} distinct); resumed with Range ${ranges.join(', ')}; JS heap during download ${(minHeap / 2 ** 20).toFixed(0)}-${(maxHeap / 2 ** 20).toFixed(0)} MiB; ${seconds.toFixed(1)} s; ${summary}`;
  });

  ok = true;
} catch {
  ok = false;
  const state = await page
    ?.evaluate(() => {
      const store = window.reduxStore?.getState();
      return {
        appView: store?.app?.appView,
        network: store?.network,
        installer: store?.installer?.step,
        boot: document.documentElement.dataset.boot,
      };
    })
    .catch(error => `(could not read: ${error.message})`);
  console.log(`app state at failure: ${JSON.stringify(state)}`);
  if (process.env.E2E_ARTIFACTS && page) {
    const file = join(process.env.E2E_ARTIFACTS, `failure-${current}.png`);
    await page.screenshot({ path: file }).then(
      () => console.log(`screenshot: ${file}`),
      () => undefined
    );
    const qrSvg = await page.$eval(QR, e => e.outerHTML).catch(() => undefined);
    if (qrSvg) await writeFile(join(process.env.E2E_ARTIFACTS, `failure-${current}-qr.svg`), qrSvg);
  }
} finally {
  const secrets = logLines.filter(l => SECRET_PATTERNS.some(p => p.test(l)));
  const unhandled = logLines.filter(l => /Top-level unhandled/.test(l));
  for (const watcher of watchers) problems.push(...(await watcher.report()));
  // Firefox reports a local URL whose answer failed (a video's preview
  // while it downloads: STATUS.md, open issues) as a page error; counted,
  // not failed, in Firefox runs.
  const firefoxMediaErrors = FIREFOX ? pageErrors.filter(e => /A ServiceWorker intercepted the request and encountered an unexpected error/.test(e)) : [];
  if (firefoxMediaErrors.length) console.log(`Firefox: ${firefoxMediaErrors.length} failed local media loads (known issue)`);
  // Firefox also reports a WebSocket whose connection was reset (the relay
  // dropping it: a fault) as a page error ("... was interrupted while the
  // page was loading", its text for any reset): a network message, not an
  // exception.
  const relayDrops = FIREFOX
    ? pageErrors.filter(e => e === `The connection to ${RELAY_URL}?host=localhost&port=443 was interrupted while the page was loading.`)
    : [];
  if (relayDrops.length) console.log(`Firefox: ${relayDrops.length} dropped relay connections reported as page errors`);
  for (const e of pageErrors) if (!firefoxMediaErrors.includes(e) && !relayDrops.includes(e)) problems.push(`uncaught exception: ${e}`);
  if (localUrlsOnServer.length) problems.push(`${localUrlsOnServer.length} local (attachment) URLs reached the site's server`);
  for (const line of unhandled) problems.push(`unhandled error: ${line.slice(0, 200)}`);
  for (const line of secrets) problems.push(`secret-looking log line: ${line.slice(0, 80)}...`);
  console.log(`relay: ${JSON.stringify(relay.stats)}`);
  if (faultLog.length) console.log(`faults injected: ${faultLog.length}`);
  console.log(`log lines: ${logLines.length}, uncaught exceptions: ${pageErrors.length}, secret-looking: ${secrets.length}`);
  console.log('\nresults:');
  for (const r of results) console.log(`  (${r.id}) ${r.ok ? 'PASS' : 'FAIL'} ${r.seconds.toFixed(1)} s  ${r.name}${r.note ? ` -- ${r.note}` : ''}`);
  for (const p of problems) console.log(`E2E FAIL: ${p}`);
  if (current && !ok) console.log(`stopped at (${current})`);
  ok = ok && problems.length === 0;
  console.log(ok ? 'E2E PASS' : 'E2E FAIL');
  await browser.close().catch(() => undefined);
  site.close();
  await relay.close();
  await server.close().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
