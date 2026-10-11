// SPDX-License-Identifier: AGPL-3.0-only
// node:timers/promises (setTimeout with an optional AbortSignal).

export function setTimeout<T = void>(
  delay?: number,
  value?: T,
  options?: { signal?: AbortSignal }
): Promise<T> {
  const signal = options?.signal;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(value as T);
    }, delay);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export default { setTimeout };
