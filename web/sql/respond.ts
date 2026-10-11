// SPDX-License-Identifier: AGPL-3.0-only
//
// Responses from the SQL worker to the page (protocol.ts).

import { parseSqliteError } from '../../ts/sql/errors.std.ts';
import type { WrappedWorkerRequest, WrappedWorkerResponse } from './protocol.ts';

export const scope = globalThis as unknown as {
  postMessage(message: WrappedWorkerResponse): void;
  addEventListener(type: 'message', fn: (event: MessageEvent<WrappedWorkerRequest>) => void): void;
  location: Location;
};

export function respond(seq: number, response?: unknown): void {
  scope.postMessage({ type: 'response', seq, error: undefined, errorKind: undefined, response });
}

export function respondError(seq: number, error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  scope.postMessage({
    type: 'response',
    seq,
    error: { name: err.name, message: err.message, stack: err.stack },
    errorKind: parseSqliteError(err),
    response: undefined,
  });
}
