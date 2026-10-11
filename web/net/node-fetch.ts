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

import { Buffer } from 'node:buffer';

import { AbortError, FetchError, Headers, Response } from 'node-fetch';
import type { RequestInfo, RequestInit, ResponseInit } from 'node-fetch';

import { createLogger } from '../../ts/logging/log.std.ts';
import { errorReason } from '../transport/dist/index.js';
import { getCarrier } from './carrier.ts';

export * from 'node-fetch';

const log = createLogger('https');

// Desktop's 0 means "no timeout" (large downloads and uploads).
const MAX_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

type WebRequestInit = RequestInit & { ca?: string; timeout?: number };

async function bodyBytes(body: unknown): Promise<Uint8Array | undefined> {
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    const chunks: Array<Buffer> = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new FetchError('unsupported request body in the web build', 'system');
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
  const body = await bodyBytes(init.body);
  const timeout = init.timeout ? Math.min(init.timeout, MAX_TIMEOUT_MS) : init.timeout === 0 ? MAX_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;

  let result;
  try {
    result = await getCarrier().request(
      {
        method: (init.method ?? 'GET').toUpperCase(),
        url: url.href,
        headers,
        body,
        rootPem: init.ca,
        timeoutMs: timeout,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      },
      signal as AbortSignal | undefined
    );
  } catch (error) {
    if (signal?.aborted) throw new AbortError('The operation was aborted.');
    const reason = errorReason(error);
    log.warn(`request to ${url.host} failed: ${reason}`);
    throw new FetchError(`request to ${url.host} failed: ${reason}`, 'system', {
      code: /timed out/i.test(reason) ? 'ETIMEDOUT' : 'ECONNRESET',
    } as never);
  }
  return new Response(result.body.length > 0 ? Buffer.from(result.body) : null, {
    status: result.status,
    headers: new Headers(result.headers),
    url: url.href,
  } as ResponseInit);
}
