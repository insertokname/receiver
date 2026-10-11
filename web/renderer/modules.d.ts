// SPDX-License-Identifier: AGPL-3.0-only
// Types for modules the web build resolves itself (see resolve.mjs).

declare module '@signalapp/libsignal-client/wasm/index.js' {
  export function initLibsignal(): Promise<void>;
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
