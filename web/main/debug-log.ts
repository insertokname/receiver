// SPDX-License-Identifier: AGPL-3.0-only
//
// The debug log, as Electron's main process assembles it for Desktop's
// debug log window ('fetch-log', then 'DebugLogs.getLogs'): the in-memory
// log (logs.ts, lines already redacted by Desktop's logger), plus what the
// main window reports about itself (capabilities, remote config, network
// statistics, ids), formatted by Desktop's own ts/logging/debuglogs.node.ts
// and redacted once more as a whole. It never leaves the browser: the web
// build has no upload (debuglogs.org); the user copies or saves it.

import type { FetchLogIpcData } from '../../ts/logging/shared.std.ts';
import { getLog } from '../../ts/logging/debuglogs.node.ts';
import { redactAll } from '../../ts/util/privacy.node.ts';
import { onSend, sendToRenderer } from './ipc.ts';
import { getLogLines } from './logs.ts';

const ADDITIONAL_DATA_TIMEOUT_MS = 3000;

let waiting: Array<(data: unknown) => void> = [];
let appVersion = 'unknown';

/** Desktop's main window answers 'additional-log-data-request' with this. */
export function installDebugLogChannels(version: string): void {
  appVersion = version;
  onSend('additional-log-data-response', (_event, data: unknown) => {
    const resolvers = waiting;
    waiting = [];
    for (const resolve of resolvers) resolve(data);
  });
}

async function additionalData(): Promise<Omit<FetchLogIpcData, 'logEntries'>> {
  const empty = { backupTierLogCode: 'unknown', capabilities: {}, remoteConfig: {}, statistics: {}, user: {} };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const data = await new Promise<unknown>(resolve => {
    waiting.push(resolve);
    // Unanswered before Desktop's window has started.
    timer = setTimeout(() => resolve(undefined), ADDITIONAL_DATA_TIMEOUT_MS);
    sendToRenderer('additional-log-data-request');
  });
  clearTimeout(timer);
  return data && typeof data === 'object' ? { ...empty, ...(data as object) } : empty;
}

function logEntries(): Array<unknown> {
  return getLogLines().map(line => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return { level: 30, time: new Date().toISOString(), msg: line };
    }
  });
}

/** The 'fetch-log' answer: the log entries and the main window's data. */
export async function fetchLogData(): Promise<FetchLogIpcData> {
  return { ...(await additionalData()), logEntries: logEntries() };
}

/** The 'DebugLogs.getLogs' answer: the debug log as text. */
export function formatDebugLog(data: unknown, userAgent = navigator.userAgent): string {
  return redactAll(getLog(data, 'none (browser)', appVersion, navigator.platform || 'unknown', userAgent, 'unknown', false));
}

/** The whole debug log, ready to show or save. */
export async function collectDebugLog(): Promise<string> {
  return formatDebugLog(await fetchLogData());
}
