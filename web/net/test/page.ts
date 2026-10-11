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
