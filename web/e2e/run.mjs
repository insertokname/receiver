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
//                clicking it opens the conversation
//   (h) link-and-sync  the QR code's capabilities; what the app does when
//                the primary offers a transfer archive (see below)
//
// Fails on CSP violations, uncaught exceptions, network destinations other
// than the page's origin and the relay, and key-like secrets in the log.
//
//   node e2e/run.mjs              (needs web/dist/app-e2e and $CHROMIUM)
//   ONLY=a,b,c node e2e/run.mjs   stop after these scenarios

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE_PATH, LOCAL_ORIGIN, decodeLinkQrCode, launchBrowser, serveSite, watchPage } from '../scripts/harness.mjs';
import { MOCK_HOST, MOCK_PORT, RELAY_PORT, RELAY_URL } from './config.mjs';
import { startMockServer } from './mock.mjs';
import { startRelay } from './relay.mjs';
import { loadBackupGenerator, loadDeviceNameDecryptor } from './backup-generator.mjs';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const REPO = join(WEB, '..');
const APP_DIR = join(WEB, 'dist/app-e2e/');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : undefined;

const QR = '.module-InstallScreenQrCodeNotScannedStep__qr-code--loaded svg';
const SECRET_PATTERNS = [/\b[0-9a-f]{64}\b/i, /PRAGMA key/i];
const STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS ?? 60_000);

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

const tmp = await mkdtemp(join(os.tmpdir(), 'receiver-e2e-'));
const linkedDeviceNames = [];
const { server, port: mockPort, mock } = await startMockServer({
  onDeviceLink: attributes => linkedDeviceNames.push(attributes?.name),
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

const site = await serveSite({ siteDir: APP_DIR });
const browser = await launchBrowser();

const logLines = [];
const pageErrors = [];
let page;
const watchers = [];

/** Opens a page in `context` (a fresh browser profile: its own storage). */
async function openPage(context = browser.defaultBrowserContext()) {
  page = await context.newPage();
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
await server.createSecondaryDevice(alice);
const phone = await server.createPrimaryDevice({ profileName: 'Myself', contacts, hasE164: true });

// Storage service: contacts (whitelisted, Alice pinned) and a group with
// Alice and Bob, pinned (ts/test-mock/helpers.node.ts createGroup).
const GROUP_TITLE = 'Weekend plans';
const group = await phone.createGroup({ title: GROUP_TITLE, members: [phone, alice, bob] });
{
  let state = mock.StorageState.getEmpty().updateAccount({
    profileKey: phone.profileKey.serialize(),
    givenName: phone.profileName,
    // Like a phone that has been in use: no onboarding story to download
    // (the mock server has none).
    hasViewedOnboardingStory: true,
  });
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
    if (!new RegExp(`^receiver \\((Chrome|Chromium), ${expectedPlatform}\\)$`).test(linkedName) || linkedName.length > 50) {
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

    // Record the notifications Desktop creates, and close the conversation
    // (no conversation open). With another conversation open, Desktop's
    // ChatsTab calls scrollToMessage(<open conversation>, <new message>)
    // and throws: an upstream race, independent of the web build.
    await page.evaluate(() => {
      const Original = window.Notification;
      window.__notifications = [];
      window.Notification = class extends Original {
        constructor(title, options) {
          super(title, options);
          window.__notifications.push({ title, body: options?.body ?? '', notification: this });
        }
      };
      window.reduxActions.conversations.showConversation({ conversationId: undefined });
    });
    await page.waitForFunction(() => !document.querySelector('.module-ConversationHeader'), { timeout: STEP_TIMEOUT_MS }).catch(() => {
      throw new Error('the conversation did not close');
    });
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
    await page.evaluate(() => {
      delete document.hasFocus;
      window.dispatchEvent(new Event('focus'));
    });
    return `permission ${permissionBefore} -> granted via the banner; notification "${shown.title}" for "${text}"; click opened the conversation`;
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
  for (const e of pageErrors) problems.push(`uncaught exception: ${e}`);
  for (const line of unhandled) problems.push(`unhandled error: ${line.slice(0, 200)}`);
  for (const line of secrets) problems.push(`secret-looking log line: ${line.slice(0, 80)}...`);
  console.log(`relay: ${JSON.stringify(relay.stats)}`);
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
