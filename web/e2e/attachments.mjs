// SPDX-License-Identifier: AGPL-3.0-only
//
// The attachment scenarios of e2e/run.mjs (after (g), in the linked app
// with Alice's conversation open):
//
//   (p) receive an image: Alice's phone encrypts and uploads it to CDN 3
//       and sends the pointer; the app downloads it, stores it encrypted in
//       OPFS and shows it through the service worker route: the timeline
//       image and the lightbox's full-size image decode to the sent
//       picture's size and pixels
//   (q) receive a file and save it: Desktop's download button, then its
//       save action; the browser's download (streamed, decrypted by the
//       service worker route) has the sent bytes
//   (r) receive a large video (Desktop's ghost-kitty.mp4 rewritten with its
//       index (moov) at the end, behind padding: ~32 MiB): it plays in the
//       lightbox, the player's jump to the index and a seek are Range
//       requests the service worker answers with 206, and the page's memory
//       does not grow by the file's size
//   (s) receive a voice note: its duration shows, it plays, a click on the
//       waveform seeks (Range, 206)
//   (t) send an image and a file from the composer (its menu, the browser's
//       file chooser): the message shows as sending, then sent; the app
//       uploaded them to CDN 3 (tus, through the HTTPS client); Alice's
//       phone decrypts the image to the bytes the app stored (Desktop
//       re-encodes pictures) and the file to the chosen file's bytes
//   (u) a contact's profile picture: Bob's profile (the mock extended with
//       an avatar on CDN 0) is fetched while linking; his avatar shows in the
//       conversation list from the service worker route, with his picture's
//       size and pixels
//   (v) a sticker and a link preview's image in received messages are
//       downloaded and shown through the service worker route
//   (w) a download interrupted half way (every connection dropped) is
//       resumed by Desktop's retry with a Range request and completes; the
//       saved file has the sent bytes
//   (x) an upload interrupted half way (every connection dropped) is
//       resumed by Desktop's tus client (HEAD for the offset, PATCH the
//       rest); the upload streams (chunked, not buffered); Alice decrypts
//       the file
//   (y) record a voice note (Desktop's recorder: the MP3 encoder worklet,
//       a fake microphone) and send it: the microphone permission is asked
//       only when recording starts; Alice decrypts an MP3
//   (z) storage full: with the origin's quota lowered (CDP; in Firefox the
//       storage is filled up to 2 MiB below its limit), a received file
//       cannot be stored; the app says so (the shell's storage-full
//       screen) instead of failing silently. Runs last: it leaves the
//       window on that screen.

import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FIREFOX } from '../scripts/harness.mjs';
import { loadAttachmentHelpers } from './backup-generator.mjs';

// Firefox (WebDriver BiDi) does not say whether a service worker answered;
// there, that no local URL reached the site's server (run.mjs) shows it.
const viaServiceWorker = response => FIREFOX || response.fromServiceWorker();

/** The top-level boxes of an MP4 file. */
function mp4Boxes(data, start = 0, end = data.length) {
  const boxes = [];
  for (let at = start; at + 8 <= end; ) {
    let size = data.readUInt32BE(at);
    const type = data.toString('latin1', at + 4, at + 8);
    if (size === 1) size = Number(data.readBigUInt64BE(at + 8));
    if (size === 0) size = end - at;
    boxes.push({ type, at, size });
    at += size;
  }
  return boxes;
}

/** Adds `delta` to every chunk offset (stco, co64) in a moov box. */
function shiftChunkOffsets(moov, delta) {
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);
  const walk = (start, end) => {
    for (const box of mp4Boxes(moov, start, end)) {
      if (containers.has(box.type)) walk(box.at + 8, box.at + box.size);
      if (box.type === 'stco' || box.type === 'co64') {
        const count = moov.readUInt32BE(box.at + 12);
        for (let i = 0; i < count; i += 1) {
          if (box.type === 'stco') {
            const at = box.at + 16 + i * 4;
            moov.writeUInt32BE(moov.readUInt32BE(at) + delta, at);
          } else {
            const at = box.at + 16 + i * 8;
            moov.writeBigUInt64BE(moov.readBigUInt64BE(at) + BigInt(delta), at);
          }
        }
      }
    }
  };
  walk(0, moov.length);
}

/**
 * An MP4 (ftyp, moov, mdat) rewritten as ftyp, mdat, free (`padding`
 * bytes), moov: a player must fetch the end of the file to play it.
 */
function moovAtEnd(data, padding) {
  const boxes = Object.fromEntries(mp4Boxes(data).map(box => [box.type, box]));
  const { ftyp, moov, mdat } = boxes;
  if (!ftyp || !moov || !mdat || moov.at > mdat.at) throw new Error('unexpected MP4 layout');
  const index = Buffer.from(data.subarray(moov.at, moov.at + moov.size));
  shiftChunkOffsets(index, -moov.size);
  const free = Buffer.alloc(padding);
  free.writeUInt32BE(padding, 0);
  free.write('free', 4, 'latin1');
  return Buffer.concat([data.subarray(ftyp.at, ftyp.at + ftyp.size), data.subarray(mdat.at, mdat.at + mdat.size), free, index]);
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(data) {
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

export async function runAttachmentScenarios(ctx) {
  const { scenario, server, mock, alice, bob, bobAvatar, relay, REPO, STEP_TIMEOUT_MS, tmp } = ctx;
  const page = () => ctx.page();
  const desktop = ctx.desktop();
  const helpers = await loadAttachmentHelpers();
  const store = (cdnKey, stream) => server.storeAttachmentOnCdn(3, cdnKey, stream);

  /** Alice sends `attachments` (pointers) with `text`; resolves to the message's timestamp. */
  async function aliceSends(text, attachments) {
    const timestamp = Date.now();
    await alice.sendRaw(
      desktop,
      {
        content: { dataMessage: { ...mock.EMPTY_DATA_MESSAGE, body: text, attachments, timestamp: BigInt(timestamp) } },
        pniSignatureMessage: null,
        senderKeyDistributionMessage: null,
      },
      { timestamp }
    );
    return timestamp;
  }

  /** The message's attachments as the app's state has them. */
  function attachmentsOf(timestamp) {
    return page().evaluate(t => {
      const { messagesLookup } = window.reduxStore.getState().conversations;
      const message = Object.values(messagesLookup).find(m => m.sent_at === t);
      return message?.attachments?.map(a => ({ path: a.path, pending: a.pending, size: a.size, error: a.error, downloadPath: a.downloadPath })) ?? [];
    }, timestamp);
  }

  async function waitFor(fn, what, timeout = STEP_TIMEOUT_MS) {
    const deadline = Date.now() + timeout;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const value = await fn();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out after ${timeout / 1000} s waiting for ${what}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /** Lets the browser save downloads into a new directory; resolves to { dir, done(name) }. */
  async function captureDownloads() {
    if (FIREFOX) {
      // Firefox saves to the directory set at launch (harness.mjs).
      const dir = process.env.FIREFOX_DOWNLOAD_DIR;
      return {
        dir,
        async done(name) {
          // Firefox writes to <name>.part (an empty <name> stands in) and
          // renames it at the end.
          let last = -1;
          let same = 0;
          return waitFor(async () => {
            const names = await readdir(dir);
            if (!names.includes(name) || names.some(n => n.endsWith('.part'))) return undefined;
            const data = await readFile(join(dir, name));
            same = data.length === last && data.length > 0 ? same + 1 : 0;
            last = data.length;
            return same >= 3 ? data : undefined;
          }, `the download of ${name}`);
        },
        close: async () => undefined,
      };
    }
    const dir = await mkdtemp(join(tmp, 'download-'));
    const cdp = await page().createCDPSession();
    const finished = new Map();
    const started = new Map();
    cdp.on('Browser.downloadWillBegin', e => started.set(e.guid, e.suggestedFilename));
    cdp.on('Browser.downloadProgress', e => {
      if (e.state === 'completed' || e.state === 'canceled') finished.set(started.get(e.guid), e);
    });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true });
    return {
      dir,
      async done(name) {
        const event = await waitFor(() => finished.get(name), `the download of ${name}`);
        if (event.state !== 'completed') throw new Error(`the download of ${name} was ${event.state}`);
        return readFile(join(dir, event.guid ?? [...started.entries()].find(([, n]) => n === name)[0]));
      },
      names: () => [...started.values()],
      files: () => readdir(dir),
      close: () => cdp.detach(),
    };
  }

  function messageSelector(timestamp) {
    return `.module-timeline__messages__container [data-testid="${timestamp}"]`;
  }

  /**
   * Compares the image element `selector` with `data` decoded by the
   * browser itself: natural size and pixels at a grid of points.
   */
  async function compareImage(selector, data, contentType, src) {
    return page().evaluate(
      async (sel, base64, type, url) => {
        let shown = document.querySelector(sel);
        if (url) {
          shown = new Image();
          shown.src = url;
        }
        const reference = new Image();
        reference.src = `data:${type};base64,${base64}`;
        await reference.decode();
        await shown.decode();
        const pixels = image => {
          const canvas = document.createElement('canvas');
          canvas.width = reference.naturalWidth;
          canvas.height = reference.naturalHeight;
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const a = pixels(shown);
        const b = pixels(reference);
        let samples = 0;
        let differing = 0;
        for (let y = 0; y < reference.naturalHeight; y += Math.max(1, Math.floor(reference.naturalHeight / 16))) {
          for (let x = 0; x < reference.naturalWidth; x += Math.max(1, Math.floor(reference.naturalWidth / 16))) {
            const i = (y * reference.naturalWidth + x) * 4;
            samples += 1;
            if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) differing += 1;
          }
        }
        return {
          src: shown.currentSrc,
          width: shown.naturalWidth,
          height: shown.naturalHeight,
          samples,
          differing,
          sample: Array.from(a.slice(0, 4)),
        };
      },
      selector,
      data.toString('base64'),
      contentType,
      src
    );
  }

  await scenario('p', 'receive an image: timeline and full-size view through the service worker route', async () => {
    const data = await readFile(join(REPO, 'fixtures/cat-screenshot.png'));
    const { width, height } = pngSize(data);
    const pointer = await helpers.encryptAttachment(data, 'image/png', store, { width, height });
    const text = `A picture ${Date.now()}`;
    const timestamp = await aliceSends(text, [pointer]);
    const image = `${messageSelector(timestamp)} img.module-image__image[data-loaded="true"]`;
    await page()
      .waitForSelector(image, { timeout: STEP_TIMEOUT_MS })
      .catch(() => {
        throw new Error('the image did not load in the timeline');
      });
    const controlled = await page().evaluate(() => Boolean(navigator.serviceWorker.controller));
    const inline = await compareImage(image, data, 'image/png');
    if (!new URL(inline.src).pathname.includes('/attachment/')) throw new Error(`timeline image src is ${inline.src.slice(0, 80)}`);
    if (inline.width !== width || inline.height !== height) {
      throw new Error(`timeline image is ${inline.width}x${inline.height}, sent ${width}x${height}`);
    }
    if (inline.differing) throw new Error(`timeline image: ${inline.differing} of ${inline.samples} sampled pixels differ`);

    await page().click(image);
    const full = '.Lightbox__object';
    await page()
      .waitForFunction(sel => document.querySelector(sel)?.complete && document.querySelector(sel).naturalWidth > 0, { timeout: STEP_TIMEOUT_MS }, full)
      .catch(() => {
        throw new Error('the lightbox did not show the image');
      });
    const large = await compareImage(full, data, 'image/png');
    if (large.width !== width || large.height !== height) throw new Error(`lightbox image is ${large.width}x${large.height}`);
    if (large.differing) throw new Error(`lightbox image: ${large.differing} of ${large.samples} sampled pixels differ`);
    await page().keyboard.press('Escape');
    await page().waitForFunction(() => !document.querySelector('.Lightbox__object'), { timeout: 10_000 }).catch(() => undefined);

    // A hard reload (Shift+Reload) loads the page without the service
    // worker; the page gets it back before the app shows media. WebDriver
    // BiDi (Firefox) cannot reload bypassing the cache yet.
    let hardReload = 'not tried (WebDriver BiDi has no hard reload)';
    if (!FIREFOX) {
      await page().reload({ ignoreCache: true, waitUntil: 'domcontentloaded' });
      await ctx.waitForSelector('#LeftPane', 'the inbox after a hard reload', 120_000);
      const control = await page().evaluate(() => window.__webBoot?.control);
      await ctx.openConversation(alice);
      await page()
        .waitForSelector(image, { timeout: STEP_TIMEOUT_MS })
        .catch(() => {
          throw new Error(`the image did not load after a hard reload (service worker: ${control})`);
        });
      const again = await compareImage(image, data, 'image/png');
      if (again.differing) throw new Error(`after a hard reload: ${again.differing} of ${again.samples} sampled pixels differ`);
      hardReload = `${control}, image identical`;
    }
    return `${width}x${height} PNG (${data.length} bytes): timeline and lightbox ${large.width}x${large.height}, ${large.samples} sampled pixels identical (first RGBA ${large.sample.join(',')}); page controlled by the service worker: ${controlled}; after a hard reload: ${hardReload}`;
  });

  await scenario('q', 'receive a file and save it: the browser downloads the sent bytes', async () => {
    const data = randomBytes(1536 * 1024 + 123);
    const fileName = `notes-${Date.now()}.pdf`;
    const pointer = await helpers.encryptAttachment(data, 'application/pdf', store, { fileName });
    const text = `A document ${Date.now()}`;
    const timestamp = await aliceSends(text, [pointer]);
    const button = `${messageSelector(timestamp)} .module-message__simple-attachment`;
    await page()
      .waitForSelector(button, { timeout: STEP_TIMEOUT_MS })
      .catch(() => {
        throw new Error('the file message did not appear');
      });
    const downloads = await captureDownloads();
    try {
      if (!(await attachmentsOf(timestamp))[0]?.path) {
        // Not downloaded automatically: Desktop's button downloads it first.
        await page().click(button);
      }
      await waitFor(async () => (await attachmentsOf(timestamp))[0]?.path, 'the attachment to be downloaded');
      const started = Date.now();
      await page().click(button);
      const saved = await downloads.done(fileName);
      if (!saved.equals(data)) throw new Error(`saved ${saved.length} bytes differ from the ${data.length} sent`);
      return `${fileName}: ${data.length} bytes saved by the browser ${((Date.now() - started) / 1000).toFixed(1)} s after the click, identical to what Alice sent`;
    } finally {
      await downloads.close();
    }
  });

  await scenario('r', 'receive a large video: plays, Range requests answered with 206 by the service worker, bounded memory', async () => {
    const responses = [];
    const onResponse = response => {
      if (!new URL(response.url()).pathname.includes('/attachment/')) return;
      responses.push({
        status: response.status(),
        range: response.request().headers().range,
        sw: viaServiceWorker(response),
      });
    };
    page().on('response', onResponse);
    const data = moovAtEnd(await readFile(join(REPO, 'fixtures/ghost-kitty.mp4')), 28 * 1024 * 1024);
    const pointer = await helpers.encryptAttachment(data, 'video/mp4', store);
    const text = `A video ${Date.now()}`;
    const timestamp = await aliceSends(text, [pointer]);
    await page()
      .waitForSelector(`${messageSelector(timestamp)} .module-image`, { timeout: STEP_TIMEOUT_MS })
      .catch(() => {
        throw new Error('the video message did not appear');
      });
    if (!(await attachmentsOf(timestamp))[0]?.path && !(await attachmentsOf(timestamp))[0]?.pending) {
      await page().click(`${messageSelector(timestamp)} .module-image`);
    }
    const downloadStarted = Date.now();
    await waitFor(async () => (await attachmentsOf(timestamp))[0]?.path, 'the video to be downloaded', 120_000);
    const downloadSeconds = (Date.now() - downloadStarted) / 1000;
    const thumbnail = `${messageSelector(timestamp)} img.module-image__image[data-loaded="true"]`;
    await page()
      .waitForSelector(thumbnail, { timeout: STEP_TIMEOUT_MS })
      .catch(() => {
        throw new Error("the video's screenshot did not appear in the timeline");
      });
    // The lightbox takes the message from the database: let the download's
    // result be saved first.
    await new Promise(resolve => setTimeout(resolve, 1000));

    // The page's JS heap (Chromium's DevTools protocol; not measured in Firefox).
    const cdp = FIREFOX ? undefined : await page().createCDPSession();
    await cdp?.send('Performance.enable');
    const heap = async () => {
      if (!cdp) return 0;
      const { metrics } = await cdp.send('Performance.getMetrics');
      return metrics.find(m => m.name === 'JSHeapUsedSize').value;
    };
    await cdp?.send('HeapProfiler.collectGarbage');
    const baseline = await heap();
    let peak = baseline;
    const sampler = setInterval(() => {
      heap().then(
        value => {
          peak = Math.max(peak, value);
        },
        () => undefined
      );
    }, 100);
    const beforePlaying = responses.length;
    let duration;
    let target;
    try {
      const video = '.Lightbox__object--video';
      // The timeline may still be scrolling to the new message: click until
      // the lightbox opens.
      for (let attempt = 0; attempt < 5 && !(await page().$(video)); attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        await (await page().$(thumbnail))?.click();
        // eslint-disable-next-line no-await-in-loop
        await page().waitForSelector(video, { timeout: 3000 }).catch(() => undefined);
      }
      await page()
        .waitForFunction(sel => document.querySelector(sel)?.currentTime > 0.5, { timeout: STEP_TIMEOUT_MS }, video)
        .catch(async () => {
          const state = await page().evaluate(sel => {
            const v = document.querySelector(sel);
            return v
              ? { paused: v.paused, readyState: v.readyState, networkState: v.networkState, error: v.error?.message, time: v.currentTime }
              : 'no video element';
          }, video);
          throw new Error(`the video did not play in the lightbox: ${JSON.stringify(state)}`);
        });
      duration = await page().$eval(video, v => v.duration);
      target = Math.max(1, duration * 0.75);
      await page().$eval(video, (v, t) => {
        v.currentTime = t;
      }, target);
      await page()
        .waitForFunction((sel, t) => document.querySelector(sel)?.currentTime > t + 0.3, { timeout: STEP_TIMEOUT_MS }, video, target)
        .catch(() => {
          throw new Error('the video did not play on after seeking');
        });
      await page().keyboard.press('Escape');
    } finally {
      clearInterval(sampler);
      page().off('response', onResponse);
    }
    await cdp?.detach();
    const partial = responses.filter(r => r.status === 206);
    if (!partial.length) throw new Error(`no 206 responses: ${JSON.stringify(responses)}`);
    if (responses.some(r => !r.sw)) throw new Error(`a local URL was not answered by the service worker: ${JSON.stringify(responses)}`);
    const far = partial.filter(r => Number(/bytes=(\d+)/.exec(r.range ?? '')?.[1] ?? 0) > data.length / 2);
    if (!far.length) throw new Error(`no Range request near the end of the file: ${JSON.stringify(responses)}`);
    const growth = peak - baseline;
    if (growth > data.length / 2) {
      throw new Error(`the page's memory grew by ${(growth / 2 ** 20).toFixed(1)} MiB while playing a ${(data.length / 2 ** 20).toFixed(1)} MiB video`);
    }
    return (
      `${(data.length / 2 ** 20).toFixed(1)} MiB MP4 (index at the end), downloaded in ${downloadSeconds.toFixed(1)} s; ` +
      `played ${duration.toFixed(1)} s video and seeked to ${target.toFixed(1)} s; ${responses.length} requests ` +
      `(${beforePlaying} for the timeline's screenshot and preview), ` +
      `${partial.length} answered 206 by the service worker (ranges ${partial.map(r => r.range).join(', ')}); ` +
      (cdp ? `page JS heap ${(baseline / 2 ** 20).toFixed(1)} MiB, peak +${(growth / 2 ** 20).toFixed(1)} MiB` : 'heap not measured (Firefox)')
    );
  });

  await scenario('s', 'receive a voice note: duration shown, plays, seeks', async () => {
    const data = await readFile(join(REPO, 'fixtures/incompetech-com-Agnus-Dei-X.mp3'));
    const pointer = await helpers.encryptAttachment(data, 'audio/mpeg', store, { flags: 1 });
    const timestamp = await aliceSends(null, [pointer]);
    const message = messageSelector(timestamp);
    const countdown = `${message} .module-message__audio-attachment__countdown`;
    const shown = await waitFor(
      () =>
        page().evaluate(sel => {
          const text = document.querySelector(sel)?.textContent ?? '';
          return /^\d+:\d\d$/.test(text) ? text : undefined;
        }, countdown),
      "the voice note's duration"
    );
    const responses = [];
    const onResponse = response => {
      if (!new URL(response.url()).pathname.includes('/attachment/')) return;
      responses.push({ status: response.status(), range: response.request().headers().range, sw: viaServiceWorker(response) });
    };
    page().on('response', onResponse);
    const playing = () => page().evaluate(() => window.reduxStore.getState().audioPlayer.active);
    try {
      await page().click(`${message} .PlaybackButton`);
      await waitFor(async () => (await playing())?.playing && (await playing()).currentTime > 0.5, 'the voice note to play');
      const box = await (await page().$(`${message} .WaveformScrubber`)).boundingBox();
      await page().mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
      const { duration } = await page().evaluate(() => window.reduxStore.getState().audioPlayer.active);
      const after = await waitFor(async () => {
        const active = await playing();
        return active?.currentTime > (active?.duration ?? duration ?? 0) * 0.5 ? active : undefined;
      }, 'the voice note to continue from the clicked position');
      await page().click(`${message} .PlaybackButton`);
      const partial = responses.filter(r => r.status === 206);
      if (!partial.length || responses.some(r => !r.sw)) throw new Error(`requests: ${JSON.stringify(responses)}`);
      return (
        `${(data.length / 2 ** 20).toFixed(1)} MiB MP3 voice note: duration shown "${shown}", played, seek by waveform ` +
        `to ${after.currentTime.toFixed(1)} s of ${after.duration?.toFixed?.(1) ?? '?'} s; ` +
        `${responses.length} requests through the service worker, ${partial.length} answered 206 (${partial.map(r => r.range).join(', ')})`
      );
    } finally {
      page().off('response', onResponse);
    }
  });

  /** Attaches `file` through the composer's "+" menu item `item` and the file chooser. */
  async function attachViaMenu(item, file) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await page().click('.Inbox__conversation button[aria-label="Add attachment or poll"]');
        // eslint-disable-next-line no-await-in-loop
        const menuItem = await page().waitForSelector(`::-p-xpath(//*[@role="menuitem"][contains(., "${item}")])`, { timeout: 10_000 });
        // eslint-disable-next-line no-await-in-loop
        if (FIREFOX) {
          // Firefox over BiDi reports only some file dialogs (often not a
          // second one in the same page): fill the input the menu item opens.
          // eslint-disable-next-line no-await-in-loop
          await page().keyboard.press('Escape');
          const testId = item === 'File' ? 'attachfile-input' : 'attachfile-input-media';
          // eslint-disable-next-line no-await-in-loop
          const input = await page().waitForSelector(`.Inbox__conversation input[data-testid="${testId}"]`, { timeout: 10_000 });
          // eslint-disable-next-line no-await-in-loop
          await input.uploadFile(file);
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        const [chooser] = await Promise.all([page().waitForFileChooser({ timeout: 10_000 }), menuItem.click()]);
        // eslint-disable-next-line no-await-in-loop
        await chooser.accept([file]);
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
        // The menu did not open or close as expected: start over.
        // eslint-disable-next-line no-await-in-loop
        await page().keyboard.press('Escape');
      }
    }
    // Like a user, send once the composer has processed the file (Desktop
    // does not send while an attachment is still being prepared).
    const started = Date.now();
    await waitFor(
      () =>
        page().evaluate(() => {
          const attachments = Object.values(window.reduxStore.getState().composer.conversations).flatMap(c => c.attachments);
          return attachments.length > 0 && attachments.every(a => !a.pending && a.path);
        }),
      'the composer to prepare the attachment'
    ).catch(async error => {
      const state = await page().evaluate(() => {
        const attachments = Object.values(window.reduxStore.getState().composer.conversations).flatMap(c => c.attachments);
        return attachments.map(a => ({ pending: a.pending, path: Boolean(a.path), size: a.size, contentType: a.contentType }));
      });
      throw new Error(`${error.message}: ${JSON.stringify(state)}`);
    });
    return (Date.now() - started) / 1000;
  }

  /** Types `text` into the composer and sends; resolves to what Alice's phone received. */
  async function sendFromComposer(text) {
    const editor = '.Inbox__conversation [data-testid=CompositionInput][data-enabled=true] .ql-editor';
    await page().waitForSelector(editor, { timeout: STEP_TIMEOUT_MS });
    await page().click(editor);
    await page().keyboard.type(text);
    await page().keyboard.press('Enter');
    const deadline = Date.now() + STEP_TIMEOUT_MS * 2;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const message = await Promise.race([
        alice.waitForMessage(),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Alice did not receive the message')), deadline - Date.now())),
      ]);
      if (message.body === text) return message;
    }
  }

  /** The bytes of the uploaded attachment `pointer` (on the mock's CDN 3), decrypted as Alice's phone does. */
  async function aliceDownloads(pointer) {
    const key = pointer.attachmentIdentifier?.cdnKey ?? pointer.cdnKey;
    if (pointer.cdnNumber !== 3) throw new Error(`uploaded to CDN ${pointer.cdnNumber}`);
    return helpers.decryptAttachment(join(tmp, 'cdn3', 'attachments', key), {
      key: pointer.key,
      digest: pointer.digest,
      size: pointer.size,
    });
  }

  const sha256 = data => createHash('sha256').update(data).digest('hex');

  await scenario('t', 'send an image and a file from the composer: Alice decrypts the same bytes', async () => {
    const uploads = [];
    ctx.onMockEvent(event => {
      if (event.type === 'http' && event.path.startsWith('/cdn3/attachments/') && event.method !== 'GET') uploads.push(event.method);
    });
    const sendingSeen = [];
    const watchSending = () =>
      page().evaluate(() => {
        window.__sendingSeen = [];
        const observer = new MutationObserver(() => {
          for (const icon of document.querySelectorAll('.module-message__metadata__status-icon--sending')) {
            const id = icon.closest('[data-testid]')?.getAttribute('data-testid');
            if (id && !window.__sendingSeen.includes(id)) window.__sendingSeen.push(id);
          }
        });
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      });

    // The image (Desktop re-encodes it before sending).
    await watchSending();
    const imageFile = join(REPO, 'fixtures/kitten-4-112-112.jpg');
    await attachViaMenu('Photos & videos', imageFile);
    await page()
      .waitForSelector('.CompositionArea__attachment-list .module-image--loaded, .CompositionArea__attachment-list img', { timeout: STEP_TIMEOUT_MS })
      .catch(() => {
        throw new Error('the picked image did not show in the composer');
      });
    const imageText = `My picture ${Date.now()}`;
    const imageMessage = await sendFromComposer(imageText);
    const [imagePointer] = imageMessage.dataMessage.attachments ?? [];
    if (!imagePointer) throw new Error('the message reached Alice without an attachment');
    const imageBytes = await aliceDownloads(imagePointer);
    const sentTimestamp = Number(imageMessage.dataMessage.timestamp);
    const local = await page().evaluate(async t => {
      const { messagesLookup } = window.reduxStore.getState().conversations;
      const message = Object.values(messagesLookup).find(m => m.sent_at === t);
      return message?.attachments?.[0]?.path ? true : false;
    }, sentTimestamp);
    const shownImage = `${messageSelector(sentTimestamp)} img.module-image__image[data-loaded="true"]`;
    await page().waitForSelector(shownImage, { timeout: STEP_TIMEOUT_MS });
    const shownHash = await page().$eval(shownImage, async img => {
      const buffer = await (await fetch(img.src)).arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    });
    if (shownHash !== sha256(imageBytes)) throw new Error("Alice's decrypted image differs from the one the app shows");
    const imageSending = await page().evaluate(t => window.__sendingSeen.includes(String(t)), sentTimestamp);

    // A file, sent as is.
    await watchSending();
    const fileData = randomBytes(2 * 1024 * 1024 + 77);
    const fileName = `report-${Date.now()}.zip`;
    const filePath = join(tmp, fileName);
    await writeFile(filePath, fileData);
    await attachViaMenu('File', filePath);
    await page()
      .waitForSelector('.CompositionArea__attachment-list', { timeout: STEP_TIMEOUT_MS })
      .catch(() => {
        throw new Error('the picked file did not show in the composer');
      });
    const fileText = `My file ${Date.now()}`;
    const fileMessage = await sendFromComposer(fileText);
    const [filePointer] = fileMessage.dataMessage.attachments ?? [];
    if (!filePointer) throw new Error('the file message reached Alice without an attachment');
    const fileBytes = await aliceDownloads(filePointer);
    if (!fileBytes.equals(fileData)) throw new Error(`Alice decrypted ${fileBytes.length} bytes that differ from the ${fileData.length}-byte file`);
    if (filePointer.fileName !== fileName) throw new Error(`file name arrived as ${filePointer.fileName}`);
    const fileTimestamp = Number(fileMessage.dataMessage.timestamp);
    await page()
      .waitForSelector(`${messageSelector(fileTimestamp)} .module-message__metadata__status-icon--sent, ${messageSelector(fileTimestamp)} .module-message__metadata__status-icon--delivered`, {
        timeout: STEP_TIMEOUT_MS,
      })
      .catch(() => {
        throw new Error('the file message is not shown as sent');
      });
    const fileSending = await page().evaluate(t => window.__sendingSeen.includes(String(t)), fileTimestamp);

    // A video: Desktop sanitizes MP4s (libsignal's Mp4Sanitizer moves the
    // index to the front) and adds an incremental MAC.
    const videoFile = join(REPO, 'fixtures/ghost-kitty.mp4');
    await attachViaMenu('Photos & videos', videoFile);
    const videoMessage = await sendFromComposer(`My video ${Date.now()}`);
    const [videoPointer] = videoMessage.dataMessage.attachments ?? [];
    if (!videoPointer?.incrementalMac?.length) throw new Error('the video arrived without an incremental MAC');
    const videoBytes = await aliceDownloads(videoPointer);
    const videoBoxes = mp4Boxes(videoBytes).map(box => box.type);
    if (videoBoxes[0] !== 'ftyp' || !videoBoxes.includes('moov') || !videoBoxes.includes('mdat')) {
      throw new Error(`the video Alice decrypted is not an MP4: ${videoBoxes.join(', ')}`);
    }
    if (!imageSending || !fileSending) sendingSeen.push('the "sending" status was not seen for every message');
    return (
      `image: ${imageBytes.length} bytes (re-encoded by Desktop from ${(await readFile(imageFile)).length}), Alice's copy == the app's (sha256 ${shownHash.slice(0, 12)}...), stored locally: ${local}; ` +
      `file ${fileName}: ${fileData.length} bytes, Alice's copy identical; ` +
      `video: ${videoBytes.length} bytes (${videoBoxes.join(', ')}; incremental MAC ${videoPointer.incrementalMac.length} bytes); uploads: ${uploads.join(', ')}; ` +
      `"sending" shown: image ${imageSending}, file ${fileSending}`
    );
  });

  await scenario('u', "a contact's profile picture shows in the conversation list", async () => {
    const text = `Hi from Bob ${Date.now()}`;
    await bob.sendText(desktop, text);
    const avatar = `#LeftPane [data-testid="${bob.device.aci}"] .module-Avatar__image`;
    const url = await waitFor(
      () =>
        page().evaluate(sel => {
          const match = /url\(["']?([^"')]+)["']?\)/.exec(document.querySelector(sel)?.style.backgroundImage ?? '');
          return match && match[1].includes('/attachment/') ? match[1] : undefined;
        }, avatar),
      "Bob's avatar in the conversation list"
    );
    const result = await compareImage(null, bobAvatar, 'image/jpeg', url);
    if (result.differing) throw new Error(`avatar: ${result.differing} of ${result.samples} sampled pixels differ`);
    return `Bob's avatar ${result.width}x${result.height} from the service worker route; ${result.samples} sampled pixels identical to the picture he set`;
  });

  await scenario('v', "a received sticker and a link preview's image show", async () => {
    const packId = 'ae8fedafda4768fd3384d4b3b9db963d';
    await server.storeStickerPack({
      id: Buffer.from(packId, 'hex'),
      manifest: await readFile(join(REPO, `fixtures/stickerpack-${packId}.bin`)),
      stickers: [await readFile(join(REPO, `fixtures/stickerpack-${packId}-0.bin`))],
    });
    const stickerData = await readFile(join(REPO, 'fixtures/512x515-thumbs-up-lincoln.webp'));
    const stickerPointer = await helpers.encryptAttachment(stickerData, 'image/webp', store, { width: 512, height: 515 });
    const stickerTimestamp = Date.now();
    await alice.sendRaw(
      desktop,
      {
        content: {
          dataMessage: {
            ...mock.EMPTY_DATA_MESSAGE,
            sticker: {
              packId: Buffer.from(packId, 'hex'),
              packKey: Buffer.from('53f4aa8b95e1c2e75afab2328fe67eb6d7affbcd4f50cd4da89dfc325dbc73ca', 'hex'),
              stickerId: 0,
              emoji: '👍',
              data: stickerPointer,
            },
            timestamp: BigInt(stickerTimestamp),
          },
        },
        pniSignatureMessage: null,
        senderKeyDistributionMessage: null,
      },
      { timestamp: stickerTimestamp }
    );
    const sticker = `${messageSelector(stickerTimestamp)} img.module-image__image[data-loaded="true"]`;
    await page()
      .waitForSelector(sticker, { timeout: STEP_TIMEOUT_MS })
      .catch(() => {
        throw new Error('the sticker did not show');
      });
    const stickerShown = await compareImage(sticker, stickerData, 'image/webp');
    if (stickerShown.width !== 512 || stickerShown.differing) {
      throw new Error(`sticker: ${stickerShown.width}x${stickerShown.height}, ${stickerShown.differing} sampled pixels differ`);
    }

    const previewData = await readFile(join(REPO, 'fixtures/kitten-4-112-112.jpg'));
    const previewPointer = await helpers.encryptAttachment(previewData, 'image/jpeg', store, { width: 112, height: 112 });
    const url = 'https://kittens.website/cute';
    const previewTimestamp = Date.now();
    await alice.sendRaw(
      desktop,
      {
        content: {
          dataMessage: {
            ...mock.EMPTY_DATA_MESSAGE,
            body: `Look ${url}`,
            preview: [{ url, title: 'Kittens', description: 'A kitten', image: previewPointer, date: null }],
            timestamp: BigInt(previewTimestamp),
          },
        },
        pniSignatureMessage: null,
        senderKeyDistributionMessage: null,
      },
      { timestamp: previewTimestamp }
    );
    const preview = `${messageSelector(previewTimestamp)} .module-message__link-preview img.module-image__image[data-loaded="true"]`;
    await page()
      .waitForSelector(preview, { timeout: STEP_TIMEOUT_MS })
      .catch(() => {
        throw new Error("the link preview's image did not show");
      });
    const previewShown = await compareImage(preview, previewData, 'image/jpeg');
    if (previewShown.width !== 112 || previewShown.differing) {
      throw new Error(`preview image: ${previewShown.width}x${previewShown.height}, ${previewShown.differing} sampled pixels differ`);
    }
    return (
      `sticker ${stickerShown.width}x${stickerShown.height} WebP, ${stickerShown.samples} sampled pixels identical; ` +
      `link preview image ${previewShown.width}x${previewShown.height}, ${previewShown.samples} sampled pixels identical`
    );
  });

  await scenario('w', 'a download dropped half way resumes (Range) and completes', async () => {
    const size = 24 * 1024 * 1024 + 99;
    const data = randomBytes(size);
    const fileName = `archive-${Date.now()}.zip`;
    const pointer = await helpers.encryptAttachment(data, 'application/zip', store, { fileName });
    const path = `/cdn3/attachments/${pointer.attachmentIdentifier.cdnKey}`;
    const requests = [];
    let dropped = false;
    ctx.onMockEvent(event => {
      if (event.type !== 'http' || event.method !== 'GET' || event.path !== path) return;
      requests.push(event.range ?? 'whole');
      if (!dropped) {
        dropped = true;
        relay.afterBytesDown(Math.floor(size / 2), () => relay.dropAll());
      }
    });
    const timestamp = await aliceSends(`A big file ${Date.now()}`, [pointer]);
    const button = `${messageSelector(timestamp)} .module-message__simple-attachment`;
    await page().waitForSelector(button, { timeout: STEP_TIMEOUT_MS });
    const started = Date.now();
    const state = (await attachmentsOf(timestamp))[0];
    if (!state?.path && !state?.pending) await page().click(button);
    // Desktop retries a failed download after 30 s, from where it stopped.
    await waitFor(async () => (await attachmentsOf(timestamp))[0]?.path, 'the download to complete after the drop', 150_000);
    const seconds = (Date.now() - started) / 1000;
    if (!dropped) throw new Error('the download was never interrupted');
    const resumed = requests.filter(range => /^bytes=[1-9]\d*-$/.test(range));
    if (!resumed.length) throw new Error(`no resumed (Range) request: ${JSON.stringify(requests)}`);
    const downloads = await captureDownloads();
    try {
      await page().click(button);
      const saved = await downloads.done(fileName);
      if (!saved.equals(data)) throw new Error('the saved file differs from the sent one');
    } finally {
      await downloads.close();
    }
    return `${(size / 2 ** 20).toFixed(1)} MiB file: connections dropped half way; requests ${requests.join(', ')}; complete ${seconds.toFixed(1)} s after it started (Desktop's first retry is after 30 s); saved file identical`;
  });

  await scenario('x', 'an upload dropped half way is resumed by the tus client', async () => {
    const size = 12 * 1024 * 1024 + 5;
    const fileData = randomBytes(size);
    const fileName = `upload-${Date.now()}.zip`;
    const filePath = join(tmp, fileName);
    await writeFile(filePath, fileData);
    const uploads = [];
    let dropped = false;
    ctx.onMockEvent(event => {
      if (event.type !== 'http' || !event.path.startsWith('/cdn3/attachments/') || event.method === 'GET') return;
      uploads.push(`${event.method}${event.offset ? ` @${event.offset}` : ''}${event.chunked ? ' (chunked)' : event.length ? ` (${event.length} bytes)` : ''}`);
      if (event.method === 'POST' && !dropped) {
        dropped = true;
        relay.afterBytesUp(Math.floor(size / 2), () => relay.dropAll());
      }
    });
    const prepared = await attachViaMenu('File', filePath);
    const text = `Big upload ${Date.now()}`;
    const started = Date.now();
    const message = await sendFromComposer(text);
    const seconds = (Date.now() - started) / 1000;
    const [pointer] = message.dataMessage.attachments ?? [];
    if (!pointer) throw new Error('the message reached Alice without an attachment');
    const bytes = await aliceDownloads(pointer);
    if (!bytes.equals(fileData)) throw new Error('Alice decrypted bytes that differ from the file');
    if (!dropped) throw new Error('the upload was never interrupted');
    if (!uploads.some(u => u.startsWith('PATCH'))) throw new Error(`the upload was not resumed: ${uploads.join(', ')}`);
    if (!uploads[0]?.includes('chunked')) throw new Error(`the upload was not streamed: ${uploads.join(', ')}`);
    return `${(size / 2 ** 20).toFixed(1)} MiB file (composer ready in ${prepared.toFixed(1)} s), connections dropped half way through the upload; requests: ${uploads.join(', ')}; Alice had it ${seconds.toFixed(1)} s after sending, identical`;
  });

  await scenario('y', 'record and send a voice note: microphone asked on use, Alice decrypts an MP3', async () => {
    // The microphone is asked for (getUserMedia: the browser's prompt, which
    // the fake UI answers) only when recording starts.
    await page().evaluate(() => {
      window.__microphoneRequests = 0;
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = constraints => {
        window.__microphoneRequests += 1;
        return original(constraints);
      };
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const before = await page().evaluate(() => window.__microphoneRequests);
    const record = '.Inbox__conversation button[aria-label="Start recording voice message"]';
    await page()
      .waitForSelector(record, { timeout: STEP_TIMEOUT_MS })
      .catch(() => {
        throw new Error('no record button in the composer');
      });
    await page().click(record);
    await page()
      .waitForSelector('.CompositionRecording__timer', { timeout: STEP_TIMEOUT_MS })
      .catch(() => {
        throw new Error('recording did not start');
      });
    await new Promise(resolve => setTimeout(resolve, 3000));
    const timer = await page().$eval('.CompositionRecording__timer', e => e.textContent);
    const send = await page().waitForSelector('::-p-xpath(//*[contains(@class, "RecordingComposer")]//button[contains(., "Send")])');
    await send.click();
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    let pointer;
    while (!pointer) {
      // eslint-disable-next-line no-await-in-loop
      const message = await Promise.race([
        alice.waitForMessage(),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Alice did not receive the voice note')), deadline - Date.now())),
      ]);
      pointer = message.dataMessage.attachments?.find(a => (a.flags ?? 0) & 1);
    }
    const bytes = await aliceDownloads(pointer);
    // An MPEG audio frame header: 11 sync bits.
    const frames = [];
    for (let i = 0; i + 1 < bytes.length && frames.length < 3; i += 1) {
      if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) frames.push(i);
    }
    if (frames[0] !== 0) throw new Error(`not an MP3: starts with ${bytes.subarray(0, 4).toString('hex')}`);
    if (frames.length < 3) throw new Error(`MP3 has ${frames.length} frames`);
    const after = await page().evaluate(() => window.__microphoneRequests);
    if (before !== 0 || after !== 1) throw new Error(`microphone requested ${before} times before recording, ${after} after`);
    return `recorded ${timer}; Alice decrypted ${bytes.length} bytes of ${pointer.contentType} (MPEG frame header at 0), flags=${pointer.flags}; microphone requested ${before} times before the record button, ${after} after`;
  });

  await scenario('z', 'storage full while storing an attachment: the app says so', async () => {
    const cdp = FIREFOX ? undefined : await page().createCDPSession();
    const origin = new URL(page().url()).origin;
    const { usage } = await page().evaluate(() => navigator.storage.estimate());
    let how;
    if (cdp) {
      await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: usage + 2 * 1024 * 1024 });
      how = 'quota set to usage + 2 MiB';
    } else {
      // Firefox has no quota override: the runner limits its storage
      // (harness.mjs), and a file outside the app's directories takes all
      // but 2 MiB of what is left.
      const filled = await page().evaluate(async () => {
        const { quota, usage: used } = await navigator.storage.estimate();
        const size = quota - used - 2 * 1024 * 1024;
        const root = await navigator.storage.getDirectory();
        const writable = await (await root.getFileHandle('e2e-filler', { create: true })).createWritable();
        const chunk = new Uint8Array(8 * 1024 * 1024);
        for (let left = size; left > 0; left -= chunk.length) {
          // eslint-disable-next-line no-await-in-loop
          await writable.write(left >= chunk.length ? chunk : chunk.subarray(0, left));
        }
        await writable.close();
        return { quota, size };
      });
      how = `quota ${(filled.quota / 2 ** 20).toFixed(0)} MiB, filled to 2 MiB below it`;
    }
    try {
      const data = randomBytes(8 * 1024 * 1024);
      const fileName = `too-big-${Date.now()}.zip`;
      const pointer = await helpers.encryptAttachment(data, 'application/zip', store, { fileName });
      const timestamp = await aliceSends(`No room ${Date.now()}`, [pointer]);
      const button = `${messageSelector(timestamp)} .module-message__simple-attachment`;
      await page().waitForSelector(button, { timeout: STEP_TIMEOUT_MS });
      const state = (await attachmentsOf(timestamp))[0];
      if (!state?.path && !state?.pending) await page().click(button);
      await page()
        .waitForSelector('[data-web-screen="storage-full"]', { timeout: STEP_TIMEOUT_MS })
        .catch(() => {
          throw new Error('no storage-full message');
        });
      const text = await page().$eval('[data-web-screen="storage-full"]', e => e.querySelector('h1, h2')?.innerText ?? e.innerText);
      return `${how}, an 8 MiB file received: "${text.slice(0, 80)}..."`;
    } finally {
      if (cdp) {
        await cdp.send('Storage.overrideQuotaForOrigin', { origin }).catch(() => undefined);
        await cdp.detach();
      } else {
        await page()
          .evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('e2e-filler'))
          .catch(() => undefined);
      }
    }
  });
}
