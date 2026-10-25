// SPDX-License-Identifier: AGPL-3.0-only
//
// A large GET as byte ranges fetched in parallel over a few circuits,
// delivered as one in-order body, as if it had been one request.
//
// One Tor circuit carries one download at the speed its slowest relay and
// its round trip time allow; several circuits (lanes) side by side add up.
// The first request asks for the first FIRST_CHUNK bytes; if the server
// answers with a range (206) and there is more, the rest is split into
// CHUNK-sized ranges that up to `lanes` workers fetch, each over its own
// lane, each reusing its kept-alive connection from one range to the next.
// The caller sees the response it asked for: 200 with the whole length for a
// plain GET, 206 with its own Content-Range for an open range
// (`bytes=<offset>-`, how Desktop resumes a download), and a body that
// yields the bytes in order. Bytes are buffered at most `aheadBytes` past
// what the caller has read (workers wait), so memory stays bounded however
// large the download.
//
// A server that ignores ranges (200) or refuses them (anything but 206) is
// answered as is: the caller gets that response, the request is not split.
// Later ranges are fetched with If-Range (the first response's ETag), so a
// file that changed in between fails the download instead of mixing
// versions; so does a range answered with other bytes than asked for. A
// range that fails is fetched again (from where it stopped) up to
// RANGE_ATTEMPTS times, by any worker; then the body fails, as a broken
// single download would, and the caller retries as it would anyway.
//
// Circuits differ a lot in speed (a factor of ten is common), and the body
// is in order, so the slowest lane would set the pace:
// - A worker with nothing to fetch (the buffer ahead is full, or every range
//   is taken) takes over part of the range the caller waits for, when the
//   lane fetching it would need long to finish: the range is cut where both
//   lanes, at their measured speeds, finish about together; the first lane
//   stops at the cut (dropping its connection, as its response would go on).
// - A lane much slower than the best one gets a new circuit (`renewLane`,
//   if the caller provides it; otherwise its worker stops).
// - Circuits also stall outright (nothing for many seconds, then the rest at
//   once), and the caller gives up on a body that brings nothing for a while
//   (Desktop: 10 s). A spare worker on another lane, there for every
//   download, takes over the rest of the range the caller waits for once it
//   brought nothing for STALLED_MS; the stalled connection is dropped.

export const FIRST_CHUNK = 1024 * 1024;
export const CHUNK = 2 * 1024 * 1024;
const RANGE_ATTEMPTS = 3;
const DEFAULT_IDLE_MS = 60_000;
// Cutting a range: only if its lane would still need this long, and the
// other part is at least MIN_SPLIT bytes.
const SPLIT_IF_SLOWER_THAN_MS = 3_000;
const MIN_SPLIT = 256 * 1024;
// What a new request costs before data flows (a Tor stream, TLS, the request).
const REQUEST_COST_MS = 1_000;
// A speed is known after a lane received this much in one range.
const MIN_MEASURED = 256 * 1024;
// How often a worker with nothing to do looks for a stalled range.
const RECHECK_MS = 500;
// A lane this many times slower than the best one gets a new circuit.
const SLOW_LANE_FACTOR = 3;
// The range the caller waits for is taken over by another lane after this
// long without a byte; a request still waiting for its first byte (a new
// stream on a slow circuit can take several seconds) gets longer.
const STALLED_MS = 4_000;
const STALLED_FIRST_BYTE_MS = 8_000;

const header = (headers, name) => headers.find(([n]) => n.toLowerCase() === name)?.[1];
const without = (headers, ...names) => headers.filter(([n]) => !names.includes(n.toLowerCase()));

/**
 * The range a request asks for: {start, end?} for `bytes=a-` or `bytes=a-b`,
 * null for none, undefined for anything else (several ranges, a suffix).
 */
export function requestedRange(headers) {
  const value = header(headers, 'range');
  if (value === undefined) return null;
  const match = /^\s*bytes\s*=\s*(\d+)\s*-\s*(\d*)\s*$/i.exec(value);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = match[2] === '' ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(start) || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) return undefined;
  return { start, end };
}

/** `bytes <first>-<last>/<total>` -> {first, last, total}; total undefined for `*`. */
export function contentRange(value) {
  const match = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(value ?? '');
  if (!match) return undefined;
  return {
    first: Number(match[1]),
    last: Number(match[2]),
    total: match[3] === '*' ? undefined : Number(match[3]),
  };
}

function wrapSignalHttps(https, { url, rootPem, timeoutMs }) {
  return (headers, lane) =>
    https.request('GET', url, headers, undefined, rootPem, timeoutMs, lane).then(response => ({
      status: response.status,
      headers: response.headers,
      body: {
        next: idleMs => response.body.next(idleMs),
        cancel: () => {
          response.body.cancel();
          response.body.free();
        },
        done: () => response.body.free(),
      },
    }));
}

/**
 * GET `url` in parallel ranges (see above).
 *
 * `send(headers, lane)` sends the GET with those headers over `lane` and
 * resolves to {status, headers, body: {next(idleMs), cancel(), done?()}};
 * or pass a SignalHttps and {url, rootPem, timeoutMs} (its `renewLane` is
 * used). Options: `headers` ([name, value] pairs, may hold the caller's
 * Range), `lanes` (workers, one lane each, from `firstLane`), `idleMs`
 * (longest wait for a range's next piece), `renewLane(lane)` (a promise:
 * the lane's next requests go over a new circuit), `chunkBytes`,
 * `firstChunkBytes`, `aheadBytes`.
 *
 * Resolves to {status, headers, body: {next(idleMs), cancel()}}, `split`
 * true when the body comes from several ranges, and `stats()` (bytes per
 * lane, cuts, renewed lanes).
 */
export async function fetchRanged(sendOrHttps, options = {}) {
  const {
    headers = [],
    lanes = 4,
    firstLane = 1,
    idleMs = DEFAULT_IDLE_MS,
    chunkBytes = CHUNK,
    firstChunkBytes = FIRST_CHUNK,
    aheadBytes = Math.max(1, lanes) * chunkBytes,
  } = options;
  const send = typeof sendOrHttps === 'function' ? sendOrHttps : wrapSignalHttps(sendOrHttps, options);
  const renewLane =
    options.renewLane ?? (typeof sendOrHttps?.renewLane === 'function' ? lane => sendOrHttps.renewLane(lane) : undefined);
  const noStats = () => ({ lanes: {}, cuts: 0, takeovers: 0, renewed: [] });
  const asked = requestedRange(headers);
  if (asked === undefined) {
    // Not a range we split: as is.
    return { ...(await send(headers, firstLane)), split: false, stats: noStats };
  }
  const start = asked?.start ?? 0;
  const firstEnd = Math.min(start + firstChunkBytes - 1, asked?.end ?? Infinity);
  const base = without(headers, 'range', 'if-range');
  const first = await send([...base, ['Range', `bytes=${start}-${firstEnd}`]], firstLane);
  const got = first.status === 206 ? contentRange(header(first.headers, 'content-range')) : undefined;

  if (!got || got.total === undefined || got.first !== start || got.last > firstEnd || got.last >= got.total) {
    if (first.status !== 206 && first.status !== 416) {
      // The server ignores ranges (200) or failed: the same answer the
      // caller's own request would have had.
      return { ...first, split: false, stats: noStats };
    }
    // A range we cannot build on: ask the way the caller did.
    first.body.cancel();
    return { ...(await send(headers, firstLane)), split: false, stats: noStats };
  }

  // The whole response the caller asked for: [start, end].
  const total = got.total;
  const end = Math.min(asked?.end ?? total - 1, total - 1);
  const etag = header(first.headers, 'etag');
  const validator = etag && !/^\s*W\//.test(etag) ? [['If-Range', etag]] : [];
  const responseHeaders = [
    ...without(first.headers, 'content-range', 'content-length'),
    ['content-length', String(end - start + 1)],
    ...(asked === null ? [] : [['content-range', `bytes ${start}-${end}/${total}`]]),
  ];
  const status = asked === null ? 200 : 206;

  // Ranges in byte order; the first is the response already received. A
  // range: [start, end] (end moves down when it is cut), the pieces
  // received, and while a lane fetches it: which, since when, from which
  // byte. The caller reads piece `pieceIndex` of range `rangeIndex` next.
  const ranges = [];
  let rangeIndex = 0;
  let pieceIndex = 0;
  let nextStart = got.last + 1;
  let consumed = start; // bytes the caller has read, as an offset
  let failure;
  let cancelled = false;
  const retries = [];
  const active = new Set();
  // Measured speed of each lane (bytes per ms, from its last range).
  const speed = new Map();
  const stats = { lanes: {}, cuts: 0, takeovers: 0, renewed: [] };
  let wakeUp = [];
  const wake = () => {
    const waiting = wakeUp;
    wakeUp = [];
    for (const resolve of waiting) resolve();
  };
  const changed = () => new Promise(resolve => wakeUp.push(resolve));
  const fail = error => {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    for (const body of active) body.cancel();
    active.clear();
    wake();
  };
  const range = (from, to) => ({
    start: from,
    end: to,
    pieces: [],
    received: 0,
    attempts: 0,
    lane: undefined,
    since: 0,
    from: 0,
    lastData: 0,
    body: undefined,
  });
  const complete = r => r.received >= r.end - r.start + 1;
  const length = r => r.end - r.start + 1;

  // Receives `r` from `response` (which asked for bytes up to `askedEnd`)
  // until the range is complete; resolves when it is. Runs within fetchingBy.
  async function receive(r, response, askedEnd, lane) {
    active.add(response.body);
    r.body = response.body;
    try {
      while (!complete(r)) {
        if (failure || cancelled) {
          // Arrived after the end: drop its connection.
          response.body.cancel();
          return;
        }
        const piece = await response.body.next(idleMs);
        if (piece === undefined) throw new Error(`range ${r.start}-${r.end}: body ended after ${r.received} bytes`);
        if (piece.byteLength > askedEnd - r.start + 1 - r.received) {
          throw new Error(`range ${r.start}-${askedEnd}: more bytes than asked for`);
        }
        const room = length(r) - r.received;
        const take = piece.byteLength > room ? piece.subarray(0, room) : piece;
        r.pieces.push(take);
        r.received += take.byteLength;
        r.lastData = performance.now();
        stats.lanes[lane] = (stats.lanes[lane] ?? 0) + take.byteLength;
        wake();
      }
      const bytes = r.received - r.from;
      if (bytes >= MIN_MEASURED) speed.set(lane, bytes / Math.max(1, performance.now() - r.since));
      if (r.end < askedEnd) {
        // Cut short: the rest is another lane's; drop this connection.
        response.body.cancel();
        return;
      }
      // Read the end of the body, so the connection can be kept.
      if ((await response.body.next(idleMs)) !== undefined) throw new Error(`range ${r.start}-${r.end}: more bytes than asked for`);
      response.body.done?.();
    } catch (error) {
      response.body.cancel();
      throw error;
    } finally {
      active.delete(response.body);
      if (r.body === response.body) r.body = undefined;
    }
  }

  // `r` is being fetched by `lane` from now on (its speed counts from here,
  // the wait for the response included), until `fetching` settles.
  async function fetchingBy(r, lane, fetching) {
    r.lane = lane;
    r.since = performance.now();
    r.lastData = r.since;
    r.from = r.received;
    try {
      return await fetching();
    } finally {
      r.lane = undefined;
    }
  }

  // Fetches what is missing of `r` over `lane`.
  async function fetchRange(r, lane) {
    const from = r.start + r.received;
    const askedEnd = r.end;
    const response = await send([...base, ...validator, ['Range', `bytes=${from}-${askedEnd}`]], lane);
    const answer = response.status === 206 ? contentRange(header(response.headers, 'content-range')) : undefined;
    if (!answer || answer.first !== from || answer.last !== askedEnd || answer.total !== total) {
      response.body.cancel();
      throw new Error(
        response.status === 206
          ? `range ${from}-${askedEnd}: answered with ${header(response.headers, 'content-range')}`
          : `range ${from}-${askedEnd}: HTTP ${response.status} (the file changed or ranges stopped working)`
      );
    }
    await receive(r, response, askedEnd, lane);
  }

  // The range the caller waits for, if its lane brought nothing for
  // STALLED_MS: the rest of it, for `lane` (a new range); its lane's
  // connection is dropped.
  function takeOverStalledRange(lane) {
    const index = ranges.findIndex((r, i) => i >= rangeIndex && !complete(r));
    const r = ranges[index];
    if (r?.lane === undefined || r.lane === lane) return undefined;
    const waited = performance.now() - r.lastData;
    if (waited < (r.received > r.from ? STALLED_MS : STALLED_FIRST_BYTE_MS)) return undefined;
    const tail = range(r.start + r.received, r.end);
    r.end = tail.start - 1;
    ranges.splice(index + 1, 0, tail);
    stats.takeovers += 1;
    if (r.body) {
      active.delete(r.body);
      r.body.cancel();
    }
    return tail;
  }

  // The range the caller waits for, cut where `lane` and the lane fetching
  // it would finish together, if that is worth a new request; returns the
  // part for `lane` (a new range).
  function cutSlowRange(lane) {
    const index = ranges.findIndex((r, i) => i >= rangeIndex && !complete(r));
    const r = ranges[index];
    // A range nobody fetches is about to be (a retry); one being fetched
    // counts from its request, so a lane still waiting for its answer
    // (a new circuit, a slow exit) is slow too.
    if (r?.lane === undefined || r.lane === lane) return undefined;
    const elapsed = performance.now() - r.since;
    if (elapsed < 1000) return undefined;
    const remaining = length(r) - r.received;
    const ownerSpeed = (r.received - r.from) / elapsed;
    const ownerMs = ownerSpeed > 0 ? remaining / ownerSpeed : Infinity;
    if (ownerMs < SPLIT_IF_SLOWER_THAN_MS) return undefined;
    // Unknown: assume as fast as the lane fetching it.
    const helperSpeed = speed.get(lane) ?? Math.max(ownerSpeed, Number.MIN_VALUE);
    // The owner keeps x, the helper takes the rest, both done at about the
    // same time: x / owner = cost + (remaining - x) / helper.
    const both = ownerSpeed + helperSpeed;
    let keep = Math.round((remaining * ownerSpeed + REQUEST_COST_MS * ownerSpeed * helperSpeed) / both);
    keep = Math.max(0, Math.min(keep, remaining - MIN_SPLIT));
    const helperPart = remaining - keep;
    if (helperPart < MIN_SPLIT) return undefined;
    if (REQUEST_COST_MS + helperPart / helperSpeed >= ownerMs) return undefined;
    const cut = r.start + r.received + keep;
    const tail = range(cut, r.end);
    r.end = cut - 1;
    ranges.splice(index + 1, 0, tail);
    stats.cuts += 1;
    return tail;
  }

  // The next range for `lane`: one that failed, else a new one while the
  // buffer ahead of the caller has room, else part of a slow one. Waits
  // while there is none; undefined once everything is in.
  async function nextRange(lane) {
    for (;;) {
      if (failure || cancelled) return undefined;
      if (retries.length) return retries.shift();
      if (nextStart <= end && nextStart - consumed <= aheadBytes) {
        const r = range(nextStart, Math.min(nextStart + chunkBytes - 1, end));
        ranges.push(r);
        nextStart = r.end + 1;
        return r;
      }
      const part = takeOverStalledRange(lane) ?? cutSlowRange(lane);
      if (part) return part;
      if (nextStart > end && ranges.every(complete)) return undefined;
      // Progress wakes us; so does time (a stalled lane makes none).
      let timer;
      await Promise.race([changed(), new Promise(resolve => (timer = setTimeout(resolve, RECHECK_MS)))]);
      clearTimeout(timer);
    }
  }

  // After a range: a lane far slower than the best gets a new circuit (or,
  // without renewLane, its worker stops while others go on).
  async function keepLane(lane, workers) {
    const mine = speed.get(lane);
    const best = Math.max(...speed.values());
    if (mine === undefined || speed.size < 2 || mine * SLOW_LANE_FACTOR >= best) return true;
    speed.delete(lane);
    if (!renewLane) return workers() <= 1;
    stats.renewed.push(lane);
    await renewLane(lane).catch(() => undefined);
    return true;
  }

  let running = 0;
  async function worker(lane) {
    running += 1;
    try {
      for (;;) {
        const r = await nextRange(lane);
        if (!r) return;
        try {
          await fetchingBy(r, lane, () => fetchRange(r, lane));
        } catch (error) {
          if (failure || cancelled) return;
          // Taken over by another lane: nothing of it is missing here.
          if (complete(r)) continue;
          r.attempts += 1;
          if (r.attempts >= RANGE_ATTEMPTS) {
            fail(error);
            return;
          }
          retries.push(r);
          wake();
          continue;
        }
        if (!(await keepLane(lane, () => running))) return;
      }
    } finally {
      running -= 1;
      wake();
    }
  }

  const firstRange = range(start, got.last);
  ranges.push(firstRange);
  firstRange.attempts = 1;
  const firstDone = fetchingBy(firstRange, firstLane, () => receive(firstRange, first, got.last, firstLane)).catch(error => {
    if (failure || cancelled || complete(firstRange)) return;
    retries.push(firstRange);
    wake();
  });
  // The first lane continues once its first range is in (and fetches that
  // range again if it failed); the others start at once.
  const workers = [firstDone.then(() => worker(firstLane))];
  // At least one more: the spare that takes over a stalled range.
  const more = Math.min(lanes, Math.max(2, Math.ceil((end - got.last) / chunkBytes)));
  for (let i = 1; i < more; i++) workers.push(worker(firstLane + i));
  Promise.all(workers).then(() => {
    if (!failure && !cancelled && !ranges.every(complete)) {
      fail(new Error('download ended with ranges missing'));
    }
  });

  // The caller's view: pieces in order.
  const body = {
    async next(callerIdleMs = idleMs) {
      for (;;) {
        if (cancelled) throw new Error('response body cancelled');
        const r = ranges[rangeIndex];
        if (r && pieceIndex < r.pieces.length) {
          const piece = r.pieces[pieceIndex];
          r.pieces[pieceIndex] = undefined;
          pieceIndex += 1;
          consumed += piece.byteLength;
          wake();
          return piece;
        }
        if (r && complete(r)) {
          r.pieces = [];
          rangeIndex += 1;
          pieceIndex = 0;
          continue;
        }
        if (!r && consumed > end) return undefined;
        if (failure) throw failure;
        let timer;
        const idle = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no data for ${Math.round(callerIdleMs / 1000)}s`)), callerIdleMs);
        });
        try {
          await Promise.race([changed(), idle]);
        } catch (error) {
          fail(error);
          throw error;
        } finally {
          clearTimeout(timer);
        }
      }
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const b of active) b.cancel();
      active.clear();
      wake();
    },
  };
  return { status, headers: responseHeaders, body, split: end > got.last, stats: () => structuredClone(stats) };
}
