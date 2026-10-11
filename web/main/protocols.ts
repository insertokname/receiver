// SPDX-License-Identifier: AGPL-3.0-only
//
// Electron's protocol.handle() for the web build. Desktop's main process
// answers its local URLs (attachment://) with protocol handlers; here those
// handlers run in the page, and the service worker (web/sw/sw.ts) forwards
// every request for `<app>/attachment/<token>` to the page that made the URL
// (web/main/local-urls.ts) over a MessageChannel:
//
//   worker -> page   { type: 'receiver:local-request', version: 1, url, range } + port
//   page -> worker   { type: 'head', status, headers } then, for each
//                    { type: 'pull' } from the worker, one of
//                    { type: 'chunk', bytes } | { type: 'end' } | { type: 'error', message };
//                    { type: 'cancel' } from the worker stops the body.
//
// The body is pulled piece by piece, so a large video is never in memory
// as a whole. Range requests: Desktop's handler answers `bytes=N-` (all
// Chromium asks for); `bytes=N-M` (Firefox, Safari) is served from it and
// cut at M, and Content-Range is completed to `bytes N-M/size`, which
// browsers' media players require. This protocol is kept stable across
// builds: the worker of a newer build may serve an older page.

const MESSAGE_TYPE = 'receiver:local-request';
const PROTOCOL_VERSION = 1;
// Desktop decrypts and verifies a whole attachment before its first byte
// (see app/attachment_channel.main.ts), so the first piece may take a while.
const FIRST_PIECE_TIMEOUT_MS = 120_000;
// Playing a video while it downloads (disposition=download): Desktop reads
// the growing download file and waits up to 15 s for it to grow. An OPFS
// file only shows what was written once its writer closes, so until the
// download has finished there is nothing to read: give up soon after
// Desktop's wait (the player then waits for the downloaded file's URL).
const GROWING_FIRST_PIECE_TIMEOUT_MS = 20_000;
const PIECE_TIMEOUT_MS = 60_000;

type Handler = (request: Request) => Promise<Response> | Response;

const handlers = new Map<string, Handler>();

export function registerProtocol(scheme: string, handler: Handler): void {
  if (handlers.has(scheme)) {
    throw new Error(`protocol "${scheme}" is already handled`);
  }
  handlers.set(scheme, handler);
}

type HeaderPairs = Array<[string, string]>;

type Answer = {
  status: number;
  headers: HeaderPairs;
  body?: ReadableStream<Uint8Array>;
  /** Bytes of `body` to send (a closed range). */
  limit?: number;
  /** How long the first piece may take. */
  firstPieceTimeoutMs?: number;
};

let unseal: (href: string) => string | undefined = () => undefined;

function warn(message: string): void {
  // oxlint-disable-next-line no-console
  console.warn(`web protocols: ${message}`);
}

function plain(status: number, text: string, extra: HeaderPairs = []): Answer {
  return {
    status,
    headers: [['content-type', 'text/plain; charset=utf-8'], ['cache-control', 'no-store'], ...extra],
    body: new Blob([text]).stream(),
  };
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function answer(url: string, range: string | null): Promise<Answer> {
  const original = unseal(url);
  if (!original) {
    // Not a URL of this page: the worker asks the app's other windows.
    return plain(404, 'Unknown local URL', [['x-receiver-unknown', '1']]);
  }
  const parsed = new URL(original);
  const handler = handlers.get(parsed.protocol.replace(/:$/, ''));
  if (!handler) {
    return plain(404, 'Unknown protocol');
  }

  const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range.trim()) : null;
  const start = match ? Number(match[1]) : undefined;
  const end = match?.[2] ? Number(match[2]) : undefined;
  if (start !== undefined && end !== undefined && end < start) {
    return plain(416, 'Invalid range');
  }

  const headers = new Headers();
  if (start !== undefined) headers.set('range', `bytes=${start}-`);
  const response = await handler({ url: original, headers, method: 'GET' } as unknown as Request);

  const result = new Headers(response.headers);
  result.set('accept-ranges', 'bytes');
  const download = parsed.searchParams.get('webDownload');
  if (download != null) {
    result.set('content-disposition', contentDisposition(download));
  }
  let limit: number | undefined;
  if (response.status === 206 && start !== undefined) {
    const size = Number(/\/(\d+)$/.exec(result.get('content-range') ?? '')?.[1] ?? NaN);
    if (Number.isFinite(size)) {
      if (start >= size && size > 0) {
        await response.body?.cancel();
        return plain(416, 'Range not satisfiable', [['content-range', `bytes */${size}`]]);
      }
      const last = Math.min(end ?? size - 1, size - 1);
      limit = Math.max(0, last - start + 1);
      result.set('content-range', `bytes ${start}-${last}/${size}`);
      result.set('content-length', String(limit));
    } else if (end !== undefined) {
      limit = end - start + 1;
      result.delete('content-length');
    }
  }
  return {
    status: response.status,
    headers: [...result],
    body: response.body ?? undefined,
    limit,
    firstPieceTimeoutMs:
      parsed.searchParams.get('disposition') === 'download' ? GROWING_FIRST_PIECE_TIMEOUT_MS : FIRST_PIECE_TIMEOUT_MS,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no data for ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function serve(url: string, range: string | null, port: MessagePort): void {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let remaining = Infinity;
  let first = true;
  let firstTimeout = FIRST_PIECE_TIMEOUT_MS;
  let finished = false;

  const finish = (message: { type: 'end' } | { type: 'error'; message: string }) => {
    finished = true;
    port.postMessage(message);
    port.close();
    void reader?.cancel().catch(() => undefined);
  };

  const pull = async () => {
    if (finished) return;
    if (!reader || remaining <= 0) {
      finish({ type: 'end' });
      return;
    }
    try {
      // oxlint-disable-next-line no-constant-condition
      while (true) {
        // oxlint-disable-next-line no-await-in-loop
        const { done, value } = await withTimeout(reader.read(), first ? firstTimeout : PIECE_TIMEOUT_MS);
        first = false;
        if (finished) return;
        if (done) {
          finish({ type: 'end' });
          return;
        }
        if (value.byteLength === 0) continue;
        // A copy: the piece may be a view into a buffer that other pieces
        // still use (Buffer#slice does not copy), which must not be transferred.
        const piece = Uint8Array.prototype.slice.call(value, 0, Math.min(value.byteLength, remaining));
        remaining -= piece.byteLength;
        port.postMessage({ type: 'chunk', bytes: piece.buffer }, [piece.buffer]);
        return;
      }
    } catch (error) {
      if (!finished) {
        const message = error instanceof Error ? error.message : String(error);
        warn(`a local response failed: ${message}`);
        finish({ type: 'error', message });
      }
    }
  };

  port.onmessage = event => {
    const type = (event.data as { type?: unknown } | null)?.type;
    if (type === 'pull') {
      void pull();
    } else if (type === 'cancel' && !finished) {
      finished = true;
      port.close();
      void reader?.cancel().catch(() => undefined);
    }
  };

  answer(url, range).then(
    result => {
      reader = result.body?.getReader();
      remaining = result.limit ?? Infinity;
      firstTimeout = result.firstPieceTimeoutMs ?? FIRST_PIECE_TIMEOUT_MS;
      port.postMessage({ type: 'head', status: result.status, headers: result.headers });
    },
    error => {
      warn(`a local request failed: ${error instanceof Error ? error.message : String(error)}`);
      port.postMessage({ type: 'head', status: 500, headers: [['content-type', 'text/plain; charset=utf-8']] });
      finish({ type: 'end' });
    }
  );
}

/**
 * Answers the service worker's local requests from now on; `unsealUrl`
 * opens the URLs this page made (web/main/local-urls.ts).
 */
export function serveLocalRequests(unsealUrl: (href: string) => string | undefined): void {
  unseal = unsealUrl;
  if (!('serviceWorker' in navigator)) {
    warn('no service worker: attachments cannot be shown');
    return;
  }
  navigator.serviceWorker.addEventListener('message', event => {
    const data = event.data as { type?: unknown; version?: unknown; url?: unknown; range?: unknown } | null;
    const [port] = event.ports;
    if (data?.type !== MESSAGE_TYPE || !port) return;
    if (data.version !== PROTOCOL_VERSION || typeof data.url !== 'string') {
      port.postMessage({ type: 'head', status: 501, headers: [] });
      port.postMessage({ type: 'end' });
      return;
    }
    serve(data.url, typeof data.range === 'string' ? data.range : null, port);
  });
  // Messages from the worker are queued until the page says it listens.
  navigator.serviceWorker.startMessages();
}
