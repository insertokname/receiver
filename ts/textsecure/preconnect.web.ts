// SPDX-License-Identifier: AGPL-3.0-only

// Web build: libsignal-net is not part of the WebAssembly build. The
// network layer provides the same Net API over the Tor transport
// (web/net); this module hands it to Desktop like preconnect.preload.ts
// hands out libsignal's.

import type { Net } from '@signalapp/libsignal-client';

import { WebNet } from '../../web/net/index.ts';
import { getUserAgent } from '../util/getUserAgent.node.ts';
import { isStagingServer } from '../util/isStagingServer.dom.ts';
import { drop } from '../util/drop.std.ts';
import { toLogFormat } from '../types/errors.std.ts';
import { createLogger } from '../logging/log.std.ts';

const log = createLogger('preconnect');

let libsignalNet: Net.Net;

export function getLibsignalNet(): Net.Net {
  return libsignalNet;
}

if (window.SignalContext.config?.serverUrl) {
  const { config } = window.SignalContext;
  const env = isStagingServer(config.serverUrl) ? 'staging' : 'production';
  log.info(`web net environment: ${env}`);

  // Like Desktop's libsignal Net: the chat server and its trust root come
  // from the config (Signal's in production builds).
  libsignalNet = new WebNet({
    env,
    userAgent: getUserAgent(config.version),
    chatHost: new URL(config.serverUrl).host,
    rootPem: config.certificateAuthority,
  }) as unknown as Net.Net;

  drop(
    (async () => {
      try {
        log.info('WebAPI: preconnect start');
        await libsignalNet.preconnectChat();
        log.info('WebAPI: preconnect done');
      } catch (error) {
        log.error(`WebAPI: Failed to preconnect: ${toLogFormat(error)}`);
      }
    })()
  );
}
