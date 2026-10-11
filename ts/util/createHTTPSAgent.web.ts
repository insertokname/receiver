// SPDX-License-Identifier: AGPL-3.0-only

// Web build: there are no sockets to manage. HTTPS goes through Tor in
// web/net/node-fetch.ts, which ignores `agent`; this placeholder keeps
// WebAPI's agent bookkeeping working.

import type { AgentOptions } from 'node:https';

export type {
  ConnectOptionsType,
  HappyEyeballsOptions,
  HappyEyeballsResult,
} from './createHTTPSAgent.node.ts';

export type Agent = Readonly<{ web: true; options: AgentOptions }>;

export function createHTTPSAgent(options: AgentOptions = {}): Agent {
  return { web: true, options };
}
