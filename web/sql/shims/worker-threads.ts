// SPDX-License-Identifier: AGPL-3.0-only
//
// node:worker_threads inside the SQL worker (a Web Worker). Desktop's SQL
// logger (ts/sql/sqlLogger.node.ts) posts its entries to `parentPort`; here
// that is the worker's own postMessage to the page. Log arguments that can't
// be cloned are sent as strings, so logging never fails a query.

import { unavailable } from '../../renderer/shims/node/unavailable.ts';

type LogMessage = { type: 'log'; args: ReadonlyArray<unknown> };

const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', fn: (event: MessageEvent) => void): void;
};

export const parentPort = {
  postMessage(message: unknown): void {
    try {
      scope.postMessage(message);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'DataCloneError')) {
        throw error;
      }
      const log = message as LogMessage;
      if (log?.type !== 'log') {
        throw error;
      }
      scope.postMessage({ ...log, args: log.args.map(arg => String(arg)) });
    }
  },
  on(event: string, fn: (message: unknown) => void): void {
    if (event === 'message') {
      scope.addEventListener('message', e => fn(e.data));
    }
  },
};

export const isMainThread = false;
export const threadId = 1;
export const workerData = undefined;
export const Worker = unavailable('worker_threads', 'Worker');
export const MessageChannel = globalThis.MessageChannel;

export default { parentPort, isMainThread, threadId, workerData, Worker, MessageChannel };
