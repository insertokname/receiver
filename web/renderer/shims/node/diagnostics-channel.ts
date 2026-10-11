// SPDX-License-Identifier: AGPL-3.0-only
//
// node:diagnostics_channel without subscribers: channels exist, nothing is
// ever subscribed in the browser build, traced functions just run.

type Fn = (...args: Array<any>) => any;

class Channel {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  get hasSubscribers(): boolean {
    return false;
  }

  publish(_message: unknown): void {}

  subscribe(_fn: Fn): void {}

  unsubscribe(_fn: Fn): boolean {
    return false;
  }

  bindStore(): void {}

  unbindStore(): boolean {
    return false;
  }

  runStores<F extends Fn>(_data: unknown, fn: F, thisArg?: unknown, ...args: Parameters<F>): ReturnType<F> {
    return fn.apply(thisArg, args);
  }
}

const channels = new Map<string, Channel>();

export function channel(name: string): Channel {
  let result = channels.get(name);
  if (!result) {
    result = new Channel(name);
    channels.set(name, result);
  }
  return result;
}

export function hasSubscribers(_name: string): boolean {
  return false;
}

export function subscribe(name: string, fn: Fn): void {
  channel(name).subscribe(fn);
}

export function unsubscribe(name: string, fn: Fn): boolean {
  return channel(name).unsubscribe(fn);
}

export function tracingChannel(name: string) {
  return {
    start: channel(`tracing:${name}:start`),
    end: channel(`tracing:${name}:end`),
    asyncStart: channel(`tracing:${name}:asyncStart`),
    asyncEnd: channel(`tracing:${name}:asyncEnd`),
    error: channel(`tracing:${name}:error`),
    get hasSubscribers() {
      return false;
    },
    subscribe(): void {},
    unsubscribe(): boolean {
      return false;
    },
    traceSync<F extends Fn>(fn: F, _context?: unknown, thisArg?: unknown, ...args: Parameters<F>): ReturnType<F> {
      return fn.apply(thisArg, args);
    },
    tracePromise<F extends Fn>(fn: F, _context?: unknown, thisArg?: unknown, ...args: Parameters<F>): ReturnType<F> {
      return fn.apply(thisArg, args);
    },
    traceCallback<F extends Fn>(fn: F, _position?: number, _context?: unknown, thisArg?: unknown, ...args: Parameters<F>): ReturnType<F> {
      return fn.apply(thisArg, args);
    },
  };
}

export { Channel };

export default {
  channel,
  hasSubscribers,
  subscribe,
  unsubscribe,
  tracingChannel,
  Channel,
};
