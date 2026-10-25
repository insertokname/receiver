// SPDX-License-Identifier: AGPL-3.0-only
//
// fetchRanged (transport/src/ranged.js) against a fake server in memory:
//   node --test web/transport/test/ranged.test.mjs

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';

import { contentRange, fetchRanged, requestedRange } from '../src/ranged.js';

const MiB = 1024 * 1024;

/**
 * A server for `data` that answers Range requests like a CDN, in pieces of
 * `pieceBytes`. Hooks: `faults(request)` returns 'drop' to cut a body half
 * way; `ranges` false ignores ranges; `etag`.
 */
function fakeServer(data, { ranges = true, etag = '"v1"', pieceBytes = 64 * 1024, faults = () => undefined, pieceDelayMs = () => 0, headDelayMs = () => 0 } = {}) {
  const log = [];
  let open = 0;
  let maxOpen = 0;
  const send = async (headers, lane) => {
    const range = headers.find(([n]) => n.toLowerCase() === 'range')?.[1];
    const ifRange = headers.find(([n]) => n.toLowerCase() === 'if-range')?.[1];
    const request = { range, ifRange, lane };
    log.push(request);
    await new Promise(resolve => setTimeout(resolve, 1 + headDelayMs(lane)));
    let status = 200;
    let first = 0;
    let last = data.length - 1;
    let responseHeaders = [['etag', etag], ['content-type', 'application/octet-stream']];
    const match = ranges && range && /^bytes=(\d+)-(\d*)$/.exec(range);
    if (match && !(ifRange && ifRange !== etag)) {
      first = Number(match[1]);
      last = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
      if (first >= data.length) {
        return { status: 416, headers: [['content-range', `bytes */${data.length}`]], body: emptyBody() };
      }
      status = 206;
      responseHeaders.push(['content-range', `bytes ${first}-${last}/${data.length}`]);
    }
    responseHeaders.push(['content-length', String(last - first + 1)]);
    const fault = faults(request);
    let offset = first;
    let cancelled = false;
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    let closed = false;
    const close = () => {
      if (!closed) open -= 1;
      closed = true;
    };
    return {
      status,
      headers: responseHeaders,
      body: {
        async next() {
          if (cancelled) throw new Error('cancelled');
          await new Promise(resolve => setTimeout(resolve, pieceDelayMs(lane)));
          if (fault === 'drop' && offset - first >= (last - first + 1) / 2) {
            close();
            throw new Error('connection dropped');
          }
          if (offset > last) {
            close();
            return undefined;
          }
          const piece = data.subarray(offset, Math.min(offset + pieceBytes, last + 1));
          offset += piece.byteLength;
          return new Uint8Array(piece);
        },
        cancel() {
          cancelled = true;
          close();
        },
      },
    };
  };
  return { send, log, stats: () => ({ maxOpen, open }) };
}

function emptyBody() {
  return { next: async () => undefined, cancel() {} };
}

async function readAll(body, { onPiece } = {}) {
  const pieces = [];
  for (;;) {
    const piece = await body.next(5_000);
    if (!piece) break;
    pieces.push(piece);
    await onPiece?.(piece);
  }
  return Buffer.concat(pieces);
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const get = (headers, name) => headers.find(([n]) => n.toLowerCase() === name)?.[1];

test('parses ranges', () => {
  assert.deepEqual(requestedRange([]), null);
  assert.deepEqual(requestedRange([['Range', 'bytes=10-']]), { start: 10, end: undefined });
  assert.deepEqual(requestedRange([['range', 'bytes=0-99']]), { start: 0, end: 99 });
  assert.equal(requestedRange([['Range', 'bytes=-500']]), undefined);
  assert.equal(requestedRange([['Range', 'bytes=0-1,5-6']]), undefined);
  assert.deepEqual(contentRange('bytes 0-9/100'), { first: 0, last: 9, total: 100 });
  assert.equal(contentRange('bytes */100'), undefined);
});

test('a plain GET: 200, the whole file in order, over several lanes, bounded buffering', async () => {
  const data = randomBytes(11 * MiB + 12345);
  const server = fakeServer(data);
  const response = await fetchRanged(server.send, { lanes: 4, chunkBytes: MiB, aheadBytes: 4 * MiB });
  assert.equal(response.status, 200);
  assert.equal(response.split, true);
  assert.equal(get(response.headers, 'content-length'), String(data.length));
  assert.equal(get(response.headers, 'content-range'), undefined);
  const body = await readAll(response.body);
  assert.equal(sha(body), sha(data));
  const lanes = new Set(server.log.map(r => r.lane));
  assert.deepEqual([...lanes].sort(), [1, 2, 3, 4]);
  // Later ranges carry the first response's ETag.
  assert.ok(server.log.slice(1).every(r => r.ifRange === '"v1"'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(server.stats().open, 0);
});

test('a slow reader: no more than aheadBytes fetched past what it read', async () => {
  const data = randomBytes(12 * MiB);
  const server = fakeServer(data);
  const response = await fetchRanged(server.send, { lanes: 3, chunkBytes: MiB, aheadBytes: 2 * MiB });
  let read = 0;
  await readAll(response.body, {
    onPiece: async piece => {
      read += piece.byteLength;
      const requested = Math.max(
        ...server.log.map(r => Number(/^bytes=\d+-(\d+)$/.exec(r.range)?.[1] ?? 0))
      );
      // A range is started only while the buffer ahead is within the limit.
      assert.ok(requested - read < 2 * MiB + MiB, `fetched up to ${requested} after reading ${read}`);
      await new Promise(resolve => setTimeout(resolve, 0));
    },
  });
  assert.equal(read, data.length);
});

test('an open range (resuming): 206 with the caller\'s Content-Range', async () => {
  const data = randomBytes(5 * MiB);
  const server = fakeServer(data);
  const response = await fetchRanged(server.send, { headers: [['Range', 'bytes=1000-']], chunkBytes: MiB });
  assert.equal(response.status, 206);
  assert.equal(get(response.headers, 'content-range'), `bytes 1000-${data.length - 1}/${data.length}`);
  assert.equal(get(response.headers, 'content-length'), String(data.length - 1000));
  assert.equal(sha(await readAll(response.body)), sha(data.subarray(1000)));
});

test('a closed range', async () => {
  const data = randomBytes(6 * MiB);
  const server = fakeServer(data);
  const response = await fetchRanged(server.send, { headers: [['Range', `bytes=0-${4 * MiB - 1}`]], chunkBytes: MiB });
  assert.equal(response.status, 206);
  assert.equal(get(response.headers, 'content-range'), `bytes 0-${4 * MiB - 1}/${data.length}`);
  assert.equal(sha(await readAll(response.body)), sha(data.subarray(0, 4 * MiB)));
});

test('a small file: one request', async () => {
  const data = randomBytes(1000);
  const server = fakeServer(data);
  const response = await fetchRanged(server.send, {});
  assert.equal(response.status, 200);
  assert.equal(response.split, false);
  assert.equal(sha(await readAll(response.body)), sha(data));
  assert.equal(server.log.length, 1);
});

test('a server without ranges: its 200 as is', async () => {
  const data = randomBytes(3 * MiB);
  const server = fakeServer(data, { ranges: false });
  const response = await fetchRanged(server.send, {});
  assert.equal(response.status, 200);
  assert.equal(response.split, false);
  assert.equal(sha(await readAll(response.body)), sha(data));
  assert.equal(server.log.length, 1);
});

test('an empty file (416 for the first range): asked again without a range', async () => {
  const server = fakeServer(Buffer.alloc(0));
  const response = await fetchRanged(server.send, {});
  assert.equal(response.status, 200);
  assert.equal((await readAll(response.body)).length, 0);
  assert.equal(server.log.length, 2);
  assert.equal(server.log[1].range, undefined);
});

test('a range dropped half way is fetched again from where it stopped', async () => {
  const data = randomBytes(6 * MiB);
  let dropped = 0;
  const server = fakeServer(data, {
    faults: request => (request.range === `bytes=${2 * MiB}-${3 * MiB - 1}` && dropped++ === 0 ? 'drop' : undefined),
  });
  const response = await fetchRanged(server.send, { lanes: 2, chunkBytes: MiB, firstChunkBytes: MiB });
  assert.equal(sha(await readAll(response.body)), sha(data));
  assert.equal(dropped, 1);
  const resumed = server.log.find(r => r.range?.startsWith(`bytes=${2 * MiB + MiB / 2}-`));
  assert.ok(resumed, `resumed: ${server.log.map(r => r.range).join(', ')}`);
});

test('a range that keeps failing fails the body', async () => {
  const data = randomBytes(4 * MiB);
  // Every request starting in [2, 3) MiB is cut half way: 3 attempts, all cut.
  const server = fakeServer(data, {
    faults: request => {
      const from = Number(/^bytes=(\d+)-/.exec(request.range ?? '')?.[1] ?? -1);
      return from >= 2 * MiB && from < 3 * MiB ? 'drop' : undefined;
    },
  });
  const response = await fetchRanged(server.send, { lanes: 2, chunkBytes: MiB, firstChunkBytes: MiB });
  await assert.rejects(readAll(response.body), /dropped/);
});

test('the file changed between ranges: the body fails', async () => {
  const data = randomBytes(4 * MiB);
  const server = fakeServer(data, { etag: '"v2"' });
  // The first range says v1; later ranges with If-Range "v1" get the whole (new) file.
  const send = async (headers, lane) => {
    const response = await server.send(headers, lane);
    if (!headers.some(([n]) => n === 'If-Range')) response.headers = response.headers.map(([n, v]) => [n, n === 'etag' ? '"v1"' : v]);
    return response;
  };
  const response = await fetchRanged(send, { lanes: 2, chunkBytes: MiB, firstChunkBytes: MiB });
  await assert.rejects(readAll(response.body), /HTTP 200/);
});

test('cancel stops every range', async () => {
  const data = randomBytes(8 * MiB);
  const server = fakeServer(data, { pieceBytes: 16 * 1024 });
  const response = await fetchRanged(server.send, { lanes: 4, chunkBytes: MiB, firstChunkBytes: MiB });
  await response.body.next(5_000);
  response.body.cancel();
  await assert.rejects(response.body.next(5_000), /cancelled/);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(server.stats().open, 0);
});

test('a range answered with other bytes than asked for fails', async () => {
  const data = randomBytes(3 * MiB);
  const server = fakeServer(data);
  const send = async (headers, lane) => {
    const response = await server.send(headers, lane);
    if (headers.some(([n, v]) => n === 'Range' && v.startsWith(`bytes=${MiB}-`))) {
      response.headers = response.headers.map(([n, v]) => [n, n === 'content-range' ? `bytes 0-${MiB - 1}/${data.length}` : v]);
    }
    return response;
  };
  const response = await fetchRanged(send, { lanes: 1, chunkBytes: MiB, firstChunkBytes: MiB });
  await assert.rejects(readAll(response.body), /answered with/);
});

test('a slow lane: the range the reader waits for is split, the rest goes to the fast lanes', async () => {
  const data = randomBytes(8 * MiB);
  // Lane 2 delivers 64 KiB every 200 ms (0.3 MiB/s), the others at once.
  const server = fakeServer(data, { pieceDelayMs: lane => (lane === 2 ? 200 : 0) });
  const started = Date.now();
  const response = await fetchRanged(server.send, { lanes: 3, chunkBytes: 2 * MiB, firstChunkBytes: MiB, aheadBytes: 2 * MiB });
  assert.equal(sha(await readAll(response.body)), sha(data));
  const seconds = (Date.now() - started) / 1000;
  // Without splitting lane 2 alone would need ~6.5 s for its 2 MiB range.
  assert.ok(seconds < 5, `took ${seconds} s`);
  const cuts = server.log.filter(r => r.lane !== 2 && /^bytes=(\d+)-/.exec(r.range ?? '')?.[1] % MiB !== 0);
  assert.ok(cuts.length > 0, `no range was split: ${server.log.map(r => `${r.lane}:${r.range}`).join(', ')}`);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(server.stats().open, 0);
});

test('a slow lane gets a new circuit (renewLane)', async () => {
  const data = randomBytes(10 * MiB);
  const slow = new Set([2]);
  const server = fakeServer(data, { pieceDelayMs: lane => (slow.has(lane) ? 100 : 2) });
  const renewed = [];
  const response = await fetchRanged(server.send, {
    lanes: 3,
    chunkBytes: MiB,
    firstChunkBytes: MiB,
    renewLane: async lane => {
      renewed.push(lane);
      slow.delete(lane);
    },
  });
  assert.equal(sha(await readAll(response.body)), sha(data));
  assert.deepEqual(renewed, [2]);
  assert.deepEqual(response.stats().renewed, [2]);
});

test('without renewLane, a slow lane stops while others go on', async () => {
  const data = randomBytes(10 * MiB);
  const server = fakeServer(data, { pieceDelayMs: lane => (lane === 2 ? 100 : 2) });
  const response = await fetchRanged(server.send, { lanes: 3, chunkBytes: MiB, firstChunkBytes: MiB });
  assert.equal(sha(await readAll(response.body)), sha(data));
  // Lane 2 got its first range (and maybe a cut one), not one in four.
  const lane2 = server.log.filter(r => r.lane === 2).length;
  assert.ok(lane2 <= 2, `lane 2 had ${lane2} requests`);
});

test('a lane slow to answer: its range is taken over before any byte arrives', async () => {
  const data = randomBytes(6 * MiB);
  // Lane 2's first answer takes 8 s (a circuit being built, a slow exit).
  let delayed = false;
  const server = fakeServer(data, {
    headDelayMs: lane => (lane === 2 && !delayed ? ((delayed = true), 8000) : 0),
  });
  const started = Date.now();
  const response = await fetchRanged(server.send, { lanes: 2, chunkBytes: 2 * MiB, firstChunkBytes: MiB });
  assert.equal(sha(await readAll(response.body)), sha(data));
  const seconds = (Date.now() - started) / 1000;
  assert.ok(seconds < 4, `took ${seconds} s`);
  assert.ok(response.stats().cuts >= 1);
});
