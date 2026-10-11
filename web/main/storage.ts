// SPDX-License-Identifier: AGPL-3.0-only
//
// Small persistent key/value store for what Electron's main process keeps in
// ephemeral_config.json / config.json (theme, locale override, ...): the
// page's localStorage. Never used for keys, credentials or messages. Reads
// and writes never throw (storage can be disabled or full); a failed write
// is logged and the value is kept for this session only.

const PREFIX = 'receiver:';
const memory = new Map<string, string>();
let warned = false;

function warn(error: unknown): void {
  if (!warned) {
    warned = true;
    // oxlint-disable-next-line no-console
    console.warn('web main: localStorage unavailable, settings last for this session only', error);
  }
}

export function getStored<T>(key: string): T | undefined {
  let raw: string | null | undefined = memory.get(key);
  if (raw === undefined) {
    try {
      raw = localStorage.getItem(PREFIX + key);
    } catch (error) {
      warn(error);
    }
  }
  if (raw == null) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function setStored(key: string, value: unknown): void {
  const raw = JSON.stringify(value ?? null);
  memory.set(key, raw);
  try {
    localStorage.setItem(PREFIX + key, raw);
  } catch (error) {
    warn(error);
  }
}
