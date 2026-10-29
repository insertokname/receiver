// SPDX-License-Identifier: AGPL-3.0-only
// Types for modules the web build resolves itself (see resolve.mjs).

declare module '@signalapp/libsignal-client/wasm/index.js' {
  export function initLibsignal(options?: { wasm?: WebAssembly.Module | BufferSource }): Promise<void>;
}

declare module 'process/browser.js' {
  const process: Record<string, unknown>;
  export default process;
}

declare module 'url/url.js' {
  import type * as url from 'node:url';

  const legacy: Pick<typeof url, 'parse' | 'format' | 'resolve'>;
  export default legacy;
}

declare module 'util/util.js' {
  import type * as util from 'node:util';

  const legacy: typeof util;
  export default legacy;
}

declare module 'virtual:web-static-config' {
  const config: Record<string, unknown>;
  export default config;
}

declare module 'virtual:web-net-assets' {
  const assets: {
    /**
     * The transport's WebAssembly and its timer worker (relative to the
     * page) with their SRI digests.
     */
    transport: { wasmUrl: string; integrity: string; timerWorker: { url: string; integrity: string } };
    /** Base URL of the Tor directory snapshot, relative to the page. */
    torDirectory: string;
  };
  export default assets;
}

declare module 'virtual:web-local-assets' {
  const assets: {
    /** The SQL worker (relative to the page) and its SRI digest. */
    sqlWorker: { path: string; integrity: string };
    /** SRI digest of every locale file, by path relative to locales/. */
    locales: Record<string, string>;
  };
  export default assets;
}

declare module 'virtual:web-sw-manifest' {
  const manifest: {
    /** Digest of the file list: changes exactly when a file changes. */
    build: string;
    /** Every file of the app (path relative to the site) and its SHA-256. */
    files: Record<string, string>;
    /** The files downloaded when the service worker installs. */
    core: Array<string>;
  };
  export default manifest;
}
