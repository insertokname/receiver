// SPDX-License-Identifier: AGPL-3.0-only
//
// WebNet test page (served by net/test/run.mjs only, never deployed): the
// web build's libsignal Net and HTTPS client, through Tor, against Signal's
// real servers. Never with real credentials: authenticated checks use a
// random ACI and a bogus password.

import { initLibsignal } from '@signalapp/libsignal-client/wasm/index.js';

type Interruption = { atMs: number; code: string | null; message: string | null };

declare global {
  interface Window {
    netTest: Record<string, (...args: Array<never>) => Promise<unknown>> & { ready: Promise<void> };
  }
}

const SIGNAL_HOST = 'chat.signal.org';
const STORAGE_MANIFEST = 'https://storage.signal.org/v1/storage/manifest';

async function setUp() {
  await initLibsignal();
  const { ErrorCode } = await import('@signalapp/libsignal-client');
  const { WebNet } = await import('../index.ts');
  const { startTor, getTorCarrier } = await import('../tor.ts');
  const { SIGNAL_CA_PEM } = await import('../../transport/dist/index.js');
  const fetch = (await import('../node-fetch.ts')).default;
  const { setOnLogCallback } = await import('../../../ts/logging/log.std.ts');
  // Warnings and errors (pino levels >= 40) to the console, where the runner
  // shows them and checks that no credentials are logged.
  setOnLogCallback((level, line, prefix) => {
    // eslint-disable-next-line no-console
    if (level >= 40) console.log(`${prefix ?? ''}${line}`);
  });

  startTor();
  const net = new WebNet({ env: 'production', userAgent: 'unofficial-web-client/net-test (receiver)' });
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);

  const describe = (error: unknown) => {
    const e = error as { name?: string; code?: number; message?: string; retryAfterSecs?: number };
    return {
      name: e?.name ?? null,
      code: typeof e?.code === 'number' ? (ErrorCode[e.code] ?? String(e.code)) : (e?.code ?? null),
      message: e?.message ?? String(error),
      retryAfterSecs: e?.retryAfterSecs ?? null,
    };
  };

  function interruptionListener() {
    const interruptions: Array<Interruption> = [];
    let resolveNext: ((i: Interruption) => void) | undefined;
    const next = () => new Promise<Interruption>(resolve => (resolveNext = resolve));
    const listener = {
      onConnectionInterrupted(cause: { code: number; message: string } | null) {
        const entry = {
          atMs: now(),
          code: cause ? (ErrorCode[cause.code] ?? String(cause.code)) : null,
          message: cause?.message ?? null,
        };
        interruptions.push(entry);
        resolveNext?.(entry);
      },
    };
    return { listener, interruptions, next };
  }

  async function keepalive(connection: { fetch: (r: unknown) => Promise<{ status: number }> }) {
    const started = now();
    const response = await connection.fetch({ verb: 'GET', path: '/v1/keepalive', headers: [], timeoutMillis: 15_000 });
    return { status: response.status, ms: now() - started };
  }

  let dropConnection: { fetch: (r: unknown) => Promise<{ status: number }>; disconnect(): Promise<void> } | undefined;
  let dropWatch: ReturnType<typeof interruptionListener> | undefined;
  let dropInterrupted: Promise<Interruption> | undefined;

  window.netTest = {
    ready: (async () => {
      await getTorCarrier().ready();
    })(),

    async unauthenticatedKeepalive() {
      const { listener, interruptions } = interruptionListener();
      const started = now();
      const connection = await net.connectUnauthenticatedChat(listener as never, { languages: ['en-US', 'en'] });
      const connectMs = now() - started;
      const info = String(connection.connectionInfo());
      const result = await keepalive(connection as never);
      await connection.disconnect();
      await new Promise(resolve => setTimeout(resolve, 100));
      return { connectMs, info, ...result, interruptions };
    },

    async authenticatedBogus() {
      const { listener } = interruptionListener();
      const username = `${crypto.randomUUID()}.2`;
      const started = now();
      try {
        const connection = await net.connectAuthenticatedChat(username, 'bogus-password-for-tests', false, {
          ...listener,
          onIncomingMessage() {},
          onQueueEmpty() {},
        } as never);
        await connection.disconnect();
        return { connected: true, ms: now() - started };
      } catch (error) {
        return { connected: false, ms: now() - started, error: describe(error) };
      }
    },

    async provisioning() {
      const { listener, interruptions } = interruptionListener();
      let resolveAddress: (value: { length: number; acked: boolean }) => void = () => undefined;
      const address = new Promise<{ length: number; acked: boolean }>(resolve => (resolveAddress = resolve));
      const started = now();
      const connection = await net.connectProvisioning({
        ...listener,
        onReceivedAddress(value: string, ack: { send(status: number): void }) {
          ack.send(200);
          resolveAddress({ length: value.length, acked: true });
        },
        onReceivedEnvelope() {},
      } as never);
      const received = await Promise.race([
        address,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 30_000)),
      ]);
      const ms = now() - started;
      await connection.disconnect();
      await new Promise(resolve => setTimeout(resolve, 100));
      return { received, ms, interruptions };
    },

    /** Opens a connection to be dropped by the runner (offline mode). */
    async openForDrop() {
      dropWatch = interruptionListener();
      dropInterrupted = dropWatch.next();
      dropConnection = (await net.connectUnauthenticatedChat(dropWatch.listener as never)) as never;
      const result = await keepalive(dropConnection as never);
      return { ...result, openedAtMs: now() };
    },

    /** Waits for the interruption of the dropped connection. */
    async awaitDropInterruption(sinceMs: number) {
      const interruption = await dropInterrupted!;
      return { ...interruption, afterMs: interruption.atMs - sinceMs };
    },

    nowMs: async () => now(),

    /** Reconnects like Desktop's SocketManager would (backoff), until a keepalive works. */
    async reconnect(sinceMs: number) {
      const attempts: Array<unknown> = [];
      const delays = [0, 1000, 2000, 5000, 10_000, 15_000, 20_000, 30_000];
      for (const delay of delays) {
        await new Promise(resolve => setTimeout(resolve, delay));
        const { listener } = interruptionListener();
        try {
          const connection = await net.connectUnauthenticatedChat(listener as never);
          const result = await keepalive(connection as never);
          await connection.disconnect();
          return { ok: result.status === 200, afterMs: now() - sinceMs, attempts };
        } catch (error) {
          attempts.push({ atMs: now() - sinceMs, error: describe(error) });
        }
      }
      return { ok: false, afterMs: now() - sinceMs, attempts };
    },

    /**
     * Desktop uploads ~230 KB of prekeys per request right after linking
     * (PUT /v2/keys for ACI and PNI at once). Sends requests of that shape
     * (fake keys, no credentials, so the server reads the body and answers 401)
     * plus 1 MB more, then checks that the connection is still healthy.
     */
    async largeUploads() {
      const { listener, interruptions } = interruptionListener();
      const connection = (await net.connectUnauthenticatedChat(listener as never)) as unknown as {
        fetch: (r: unknown) => Promise<{ status: number }>;
        disconnect(): Promise<void>;
      };
      const randomBase64 = (n: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n))));
      const preKeys = (identity: string) =>
        new TextEncoder().encode(
          JSON.stringify({
            preKeys: Array.from({ length: 100 }, (_, keyId) => ({ keyId, publicKey: randomBase64(33) })),
            pqPreKeys: Array.from({ length: 100 }, (_, keyId) => ({
              keyId,
              publicKey: randomBase64(1569),
              signature: randomBase64(64),
            })),
            identity,
          })
        );
      const put = (identity: string, body: Uint8Array) =>
        connection.fetch({
          verb: 'PUT',
          path: `/v2/keys?identity=${identity}`,
          headers: [['content-type', 'application/json']],
          body,
          timeoutMillis: 120_000,
        });
      const started = now();
      const aciKeys = preKeys('aci');
      const pniKeys = preKeys('pni');
      let prekeys, prekeyMs, bulk, bulkMs, after;
      try {
        prekeys = await Promise.all([put('aci', aciKeys), put('pni', pniKeys)]);
        prekeyMs = now() - started;
        const bulkStarted = now();
        bulk = await Promise.all(
          Array.from({ length: 4 }, (_, n) => put('aci', new Uint8Array(256 * 1024).map((_b, i) => (i * 31 + n) & 0xff)))
        );
        bulkMs = now() - bulkStarted;
        after = await keepalive(connection);
      } catch (error) {
        return { failed: describe(error), afterMs: now() - started, interruptions };
      }
      const interruptedBeforeDisconnect = interruptions.length;
      await connection.disconnect();
      return {
        prekeyBytes: [aciKeys.length, pniKeys.length],
        prekeyStatuses: prekeys.map(r => r.status),
        prekeyMs,
        bulkStatuses: bulk.map(r => r.status),
        bulkMs,
        keepaliveAfter: after.status,
        interruptedBeforeDisconnect,
      };
    },

    /**
     * The page in the background (the runner hides it): one chat connection
     * kept the way Desktop keeps it (a keepalive request 30 s after each
     * answer, its WebSocketResources KeepAlive), reconnected when it is
     * interrupted. Reports the keepalives (round trips, the longest time
     * between two answers), interruptions and Tor clients replaced.
     */
    async backgroundHold(minutes: number) {
      const end = now() + minutes * 60_000;
      const rtts: Array<number> = [];
      const failures: Array<{ atMs: number; error: unknown }> = [];
      const interruptions: Array<Interruption> = [];
      let torLost = 0;
      let reconnects = 0;
      let longestGapMs = 0;
      const unsubscribe = getTorCarrier().onLost(() => {
        torLost += 1;
      });
      type Connection = { fetch: (r: unknown) => Promise<{ status: number }>; disconnect(): Promise<void> };
      let connection: Connection | undefined;
      let broken = false;
      const connect = async () => {
        const watch = interruptionListener();
        const interrupted = watch.next();
        void interrupted.then(entry => {
          interruptions.push(entry);
          broken = true;
        });
        connection = (await net.connectUnauthenticatedChat(watch.listener as never)) as never;
        broken = false;
      };
      await connect();
      let lastAnswer = now();
      while (now() < end) {
        await new Promise(resolve => setTimeout(resolve, 30_000));
        if (now() >= end) break;
        try {
          if (broken || !connection) {
            reconnects += 1;
            await connect();
          }
          const result = await keepalive(connection as Connection);
          if (result.status !== 200) throw new Error(`keepalive status ${result.status}`);
          rtts.push(result.ms);
          longestGapMs = Math.max(longestGapMs, now() - lastAnswer);
          // eslint-disable-next-line no-console
          console.log(`background: keepalive answered in ${result.ms} ms, ${now() - lastAnswer} ms after the previous answer`);
          lastAnswer = now();
        } catch (error) {
          failures.push({ atMs: now(), error: describe(error) });
          // eslint-disable-next-line no-console
          console.log(`background: keepalive failed: ${describe(error).message}`);
          broken = true;
        }
      }
      unsubscribe();
      const interrupted = [...interruptions];
      await connection?.disconnect().catch(() => undefined);
      rtts.sort((a, b) => a - b);
      return {
        minutes,
        keepalives: rtts.length,
        rttMs: rtts.length ? { median: rtts[rtts.length >> 1], max: rtts[rtts.length - 1] } : null,
        longestGapMs,
        failures,
        interruptions: interrupted,
        reconnects,
        torLost,
      };
    },

    async networkChangeProbe() {
      const { listener, interruptions } = interruptionListener();
      const connection = await net.connectUnauthenticatedChat(listener as never);
      net.onNetworkChange();
      await new Promise(resolve => setTimeout(resolve, 4000));
      const result = await keepalive(connection as never);
      const interruptedBeforeDisconnect = interruptions.length;
      await connection.disconnect();
      return { ...result, interruptedBeforeDisconnect };
    },

    async storageUnauthenticated() {
      const started = now();
      const response = await fetch(STORAGE_MANIFEST, {
        ca: SIGNAL_CA_PEM,
        headers: { 'User-Agent': 'unofficial-web-client/net-test (receiver)' },
      } as never);
      return {
        status: response.status,
        hasTimestamp: response.headers.get('x-signal-timestamp') != null,
        ms: now() - started,
      };
    },

    /**
     * A streamed request body (as Desktop's uploads send a file's read
     * stream): 1 MiB in 64 KiB pieces, unauthenticated, so the server
     * answers 401; reports how much of the body the transport pulled.
     */
    async storageStreamedUpload() {
      const { Readable } = await import('node:stream');
      const started = now();
      let pulled = 0;
      const pieces = (function* () {
        for (let i = 0; i < 16; i += 1) {
          pulled += 64 * 1024;
          yield new Uint8Array(64 * 1024).fill(i);
        }
      })();
      const response = await fetch('https://storage.signal.org/v1/storage', {
        method: 'PUT',
        ca: SIGNAL_CA_PEM,
        body: Readable.from(pieces),
        headers: { 'Content-Type': 'application/x-protobuf', 'User-Agent': 'unofficial-web-client/net-test (receiver)' },
      } as never);
      await response.arrayBuffer().catch(() => undefined);
      return { status: response.status, hasTimestamp: response.headers.get('x-signal-timestamp') != null, pulled, ms: now() - started };
    },

    async storageWrongCa(wrongCa: string) {
      try {
        const response = await fetch(STORAGE_MANIFEST, { ca: wrongCa } as never);
        return { rejected: false, status: response.status };
      } catch (error) {
        return { rejected: true, error: describe(error) };
      }
    },

    async noPinnedCa() {
      try {
        const response = await fetch(`https://${SIGNAL_HOST}/v1/keepalive`, {} as never);
        return { rejected: false, status: response.status };
      } catch (error) {
        return { rejected: true, error: describe(error) };
      }
    },

    async unavailable() {
      const results: Record<string, unknown> = {};
      try {
        await net.cdsiLookup();
      } catch (error) {
        results.cdsiLookup = describe(error);
      }
      try {
        await (net.svr2() as { restore(): Promise<void> }).restore();
      } catch (error) {
        results.svr2 = describe(error);
      }
      return results;
    },
  } as never;
}

void setUp().catch(error => {
  // eslint-disable-next-line no-console
  console.error(`net test setup failed: ${error?.stack ?? error}`);
});
