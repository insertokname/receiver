// SPDX-License-Identifier: AGPL-3.0-only
//
// node-fetch for the web build (resolve.mjs maps `node-fetch` here): the
// package itself (Headers, Response, FetchError, ...) with `fetch` replaced
// by HTTPS through Tor (the transport's hyper + rustls client).
//
// Trust is what Desktop asks for: it passes `ca` (Signal's CA, from
// config.certificateAuthority) for every Signal host it fetches from
// (storage service, CDNs, updates2 resources, upload locations), and
// node-fetch was patched to honour it, so those hosts trust that CA only.
// Requests without `ca` would use the system's roots in Desktop: link
// previews (through contentproxy.signal.org) and payments (Stripe). They
// are not available in the web build yet and fail here with a FetchError.
//
// Response bodies are streams, as in Node: `response.body` delivers the
// body as it arrives (Desktop's download progress follows it), with no
// size limit and nothing buffered beyond what the reader has not taken
// yet. `timeout` covers the request until the response head arrives (in
// Desktop 0 means none: we cap it); after that, each piece of the body must
// arrive within an idle timeout, so a hung connection fails the body
// instead of stalling it. Aborting the signal drops the connection.
//
// Downloads from Signal's CDNs (attachments, stickers, avatars: the
// `cdnUrl*` hosts of Desktop's config) are fetched in byte ranges over a few
// circuits in parallel (the carrier's `parallel`), delivered to Desktop as
// the one response it asked for; its resumption (`Range: bytes=<offset>-`)
// and checks (size, digest, incremental MAC) see the same bytes.
//
// Request bodies that are streams (uploads: Desktop passes a file's read
// stream) are streamed too: the transport pulls each piece when the
// connection takes it, so the file is never in memory as a whole and the
// stream's consumption is the upload's progress (Desktop's tus client
// counts it). `timeout` then bounds each step instead of the whole upload.

import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';

import { AbortError, FetchError, Headers, Response } from 'node-fetch';
import type { RequestInfo, RequestInit, ResponseInit } from 'node-fetch';

import { createLogger } from '../../ts/logging/log.std.ts';
import { errorReason } from '../transport/dist/index.js';
import { getCarrier } from './carrier.ts';
import type { HttpsBodyReader } from './tor.ts';

export * from 'node-fetch';

const log = createLogger('https');

// Desktop's 0 means "no timeout" (large downloads and uploads).
const MAX_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 60_000;
// Longest wait for the next piece of a response body.
const MAX_BODY_IDLE_MS = 60_000;
const MIN_BODY_IDLE_MS = 15_000;

type WebRequestInit = RequestInit & { ca?: string; timeout?: number };

// Pieces of a streamed request body handed to the transport at a time.
const MAX_PIECE = 256 * 1024;

type RequestBodySource = Uint8Array | (() => Promise<Uint8Array | undefined>) | undefined;

function requestBody(body: unknown, signal: AbortSignal | undefined): RequestBodySource {
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    const iterator = (body as AsyncIterable<Uint8Array | string>)[Symbol.asyncIterator]();
    let rest: Uint8Array | undefined;
    return async () => {
      if (signal?.aborted) throw new AbortError('The operation was aborted.');
      if (!rest?.byteLength) {
        const { done, value } = await iterator.next();
        if (done) return undefined;
        rest = typeof value === 'string' ? Buffer.from(value) : value;
      }
      // Copied, at most MAX_PIECE: the transport copies each piece into
      // WebAssembly memory, which does not shrink.
      const piece = Uint8Array.prototype.slice.call(rest, 0, MAX_PIECE);
      rest = rest.subarray(piece.byteLength);
      return piece;
    };
  }
  throw new FetchError('unsupported request body in the web build', 'system');
}

/** The origins of Desktop's CDNs (from its config; none outside the app). */
function cdnOrigins(): Set<string> {
  const config = (globalThis as { SignalContext?: { config?: Record<string, unknown> } }).SignalContext?.config;
  const origins = new Set<string>();
  for (const key of ['cdnUrl0', 'cdnUrl2', 'cdnUrl3']) {
    const value = config?.[key];
    if (typeof value !== 'string') continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // not a URL: no CDN there
    }
  }
  return origins;
}

function failure(host: string, what: string, error: unknown): FetchError {
  const reason = errorReason(error);
  log.warn(`${what} ${host} failed: ${reason}`);
  return new FetchError(`${what} ${host} failed: ${reason}`, 'system', {
    code: /timed out/i.test(reason) ? 'ETIMEDOUT' : 'ECONNRESET',
  } as never);
}

/** A Node Readable over a transport response body, read on demand. */
function bodyStream(reader: HttpsBodyReader, idleMs: number, host: string, signal: AbortSignal | undefined): Readable {
  let reading = false;
  const stream = new Readable({
    read() {
      if (reading) return;
      reading = true;
      reader.next(idleMs).then(
        piece => {
          reading = false;
          stream.push(piece === undefined ? null : Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength));
        },
        error => {
          reading = false;
          stream.destroy(signal?.aborted ? new AbortError('The operation was aborted.') : failure(host, 'response body from', error));
        }
      );
    },
    destroy(error, callback) {
      reader.cancel();
      signal?.removeEventListener('abort', onAbort);
      callback(error);
    },
  });
  const onAbort = () => stream.destroy(new AbortError('The operation was aborted.'));
  signal?.addEventListener('abort', onAbort, { once: true });
  stream.once('end', () => signal?.removeEventListener('abort', onAbort));
  return stream;
}

export default async function fetch(input: RequestInfo, init: WebRequestInit = {}): Promise<Response> {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url: string }).url);
  const url = new URL(href);
  if (url.protocol !== 'https:') {
    throw new FetchError(`${url.protocol} requests are not available in the web build`, 'system', {
      code: 'ERR_WEB_UNSUPPORTED',
    } as never);
  }
  if (!init.ca) {
    throw new FetchError(`${url.host} is not available in the web build yet (no pinned certificate authority)`, 'system', {
      code: 'ERR_WEB_UNSUPPORTED',
    } as never);
  }
  const { signal } = init;
  if (signal?.aborted) throw new AbortError('The operation was aborted.');

  const headers: Array<[string, string]> = [...new Headers(init.headers as never)];
  const body = requestBody(init.body, signal as AbortSignal | undefined);
  const timeout = init.timeout ? Math.min(init.timeout, MAX_TIMEOUT_MS) : init.timeout === 0 ? MAX_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;

  const idleMs = Math.max(MIN_BODY_IDLE_MS, Math.min(timeout, MAX_BODY_IDLE_MS));
  const method = (init.method ?? 'GET').toUpperCase();
  let result;
  try {
    result = await getCarrier().request(
      {
        method,
        url: url.href,
        headers,
        body,
        rootPem: init.ca,
        timeoutMs: timeout,
        parallel: method === 'GET' && body === undefined && cdnOrigins().has(url.origin),
        idleMs,
      },
      signal as AbortSignal | undefined
    );
  } catch (error) {
    if (signal?.aborted) throw new AbortError('The operation was aborted.');
    throw failure(url.host, 'request to', error);
  }
  if (signal?.aborted) {
    result.body.cancel();
    throw new AbortError('The operation was aborted.');
  }
  const noBody = method === 'HEAD' || result.status === 204 || result.status === 304;
  // No body: reading its end returns the connection to the pool.
  if (noBody) result.body.next(idleMs).catch(() => undefined);
  return new Response(noBody ? null : bodyStream(result.body, idleMs, url.host, signal as AbortSignal | undefined), {
    status: result.status,
    headers: new Headers(result.headers),
    url: url.href,
  } as ResponseInit);
}
