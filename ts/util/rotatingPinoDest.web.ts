// SPDX-License-Identifier: AGPL-3.0-only

// Web build: the log destination is the in-page log (web/main/logs.ts)
// instead of a rotating file.

import { EventEmitter } from 'node:events';
import type pino from 'pino';

import { appendLogLine } from '../../web/main/logs.ts';

export type RotatingPinoDestOptionsType = Readonly<{
  logFile: string;
  maxSavedLogFiles?: number;
  interval?: number;
}>;

class WebLogDestination extends EventEmitter {
  write(msg: string): boolean {
    appendLogLine(msg);
    return true;
  }

  flushSync(): void {}

  reopen(): void {}

  end(): void {}

  destroy(): void {}
}

export function createRotatingPinoDest(
  _options: RotatingPinoDestOptionsType
): ReturnType<typeof pino.destination> {
  return new WebLogDestination() as unknown as ReturnType<
    typeof pino.destination
  >;
}
