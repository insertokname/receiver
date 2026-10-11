// SPDX-License-Identifier: AGPL-3.0-only
//
// In-page replacement for Electron's IPC between the renderer and the main
// process. The renderer's `ipcRenderer` (shims/electron.ts) dispatches to
// handlers registered here; the web "main process" (web/main/) pushes events
// to renderer listeners with `sendToRenderer`.
//
// Unknown channels fail loudly: invoke() rejects and sendSync() throws with
// the channel name, and send() logs once. Arguments are never logged (they
// can carry keys, credentials or message content).

import { EventEmitter } from 'events';

export type IpcRendererEvent = {
  sender: IpcRenderer;
  senderId: number;
  ports: Array<MessagePort>;
};

type InvokeHandler = (event: IpcRendererEvent, ...args: Array<any>) => unknown;
type SendHandler = (event: IpcRendererEvent, ...args: Array<any>) => void;
type SyncHandler = (event: IpcRendererEvent, ...args: Array<any>) => unknown;

const invokeHandlers = new Map<string, InvokeHandler>();
const sendHandlers = new Map<string, SendHandler>();
const syncHandlers = new Map<string, SyncHandler>();

const logged = new Set<string>();
export function logOnce(key: string, message: string): void {
  if (logged.has(key)) {
    return;
  }
  logged.add(key);
  // oxlint-disable-next-line no-console
  console.warn(`web main: ${message}`);
}

export class IpcNotImplementedError extends Error {
  override name = 'IpcNotImplementedError';
}

/** Like ipcMain.handle: answers ipcRenderer.invoke(channel). */
export function handle(channel: string, handler: InvokeHandler): void {
  if (invokeHandlers.has(channel)) {
    throw new Error(`web main: duplicate invoke handler for ${channel}`);
  }
  invokeHandlers.set(channel, handler);
}

/** Like ipcMain.on for ipcRenderer.send(channel). */
export function onSend(channel: string, handler: SendHandler): void {
  if (sendHandlers.has(channel)) {
    throw new Error(`web main: duplicate send handler for ${channel}`);
  }
  sendHandlers.set(channel, handler);
}

/** Like ipcMain.on + event.returnValue, for ipcRenderer.sendSync(channel). */
export function onSync(channel: string, handler: SyncHandler): void {
  if (syncHandlers.has(channel)) {
    throw new Error(`web main: duplicate sync handler for ${channel}`);
  }
  syncHandlers.set(channel, handler);
}

/**
 * A channel the web build deliberately does not implement yet: invoke
 * resolves to `value` (send/sendSync likewise) and the first call logs that
 * the stub was used.
 */
export function stub(
  kind: 'invoke' | 'send' | 'sync',
  channel: string,
  value?: unknown,
  reason = 'not available in the web build'
): void {
  const handler = () => {
    logOnce(`stub:${channel}`, `ipc ${kind} "${channel}" stubbed: ${reason}`);
    return typeof value === 'function' ? value() : value;
  };
  if (kind === 'invoke') {
    handle(channel, handler);
  } else if (kind === 'send') {
    onSend(channel, handler);
  } else {
    onSync(channel, handler);
  }
}

export function implementedChannels(): Record<'invoke' | 'send' | 'sync', Array<string>> {
  return {
    invoke: [...invokeHandlers.keys()].sort(),
    send: [...sendHandlers.keys()].sort(),
    sync: [...syncHandlers.keys()].sort(),
  };
}

class IpcRenderer extends EventEmitter {
  #event(): IpcRendererEvent {
    return { sender: this, senderId: 0, ports: [] };
  }

  async invoke(channel: string, ...args: Array<unknown>): Promise<any> {
    const handler = invokeHandlers.get(channel);
    if (!handler) {
      logOnce(`invoke:${channel}`, `no handler for ipc invoke "${channel}"`);
      throw new IpcNotImplementedError(
        `ipc invoke "${channel}" is not implemented in the web build`
      );
    }
    return handler(this.#event(), ...args);
  }

  send(channel: string, ...args: Array<unknown>): void {
    const handler = sendHandlers.get(channel);
    if (!handler) {
      logOnce(`send:${channel}`, `no handler for ipc send "${channel}" (dropped)`);
      return;
    }
    try {
      handler(this.#event(), ...args);
    } catch (error) {
      // Electron's send() never throws into the renderer; report and go on.
      // oxlint-disable-next-line no-console
      console.error(`web main: ipc send "${channel}" handler failed`, error);
    }
  }

  sendSync(channel: string, ...args: Array<unknown>): any {
    const handler = syncHandlers.get(channel);
    if (!handler) {
      logOnce(`sync:${channel}`, `no handler for ipc sendSync "${channel}"`);
      throw new IpcNotImplementedError(
        `ipc sendSync "${channel}" is not implemented in the web build`
      );
    }
    return handler(this.#event(), ...args);
  }

  postMessage(channel: string): void {
    logOnce(`post:${channel}`, `ipc postMessage "${channel}" is not supported (dropped)`);
  }

  sendToHost(channel: string): void {
    logOnce(`host:${channel}`, `ipc sendToHost "${channel}" is not supported (dropped)`);
  }
}

export const ipcRenderer = new IpcRenderer();
ipcRenderer.setMaxListeners(0);

/**
 * Main -> renderer message (webContents.send in Electron). Delivered
 * asynchronously, like a message from another process.
 */
export function sendToRenderer(channel: string, ...args: Array<unknown>): void {
  queueMicrotask(() => {
    ipcRenderer.emit(channel, { sender: ipcRenderer, senderId: 0, ports: [] }, ...args);
  });
}
