// SPDX-License-Identifier: AGPL-3.0-only
//
// Timers for what keeps connections alive, kept on time while the page is
// in the background. Browsers throttle a hidden page's timers to at most
// once a second, and Chromium, after five minutes hidden, runs chained
// timers once a minute (a WebSocket does not exempt the page; audio and
// WebRTC do): a keepalive every 10 s or a check every second would then run
// once a minute, and a dead connection would go unnoticed for minutes. A
// dedicated worker's timers are not throttled that way; the worker posts a
// message when one fires, and messages wake the page at once.
//
// Without the worker (not started, or it failed) these are the page's own
// timers.

const handles = new Map();
let worker;
let nextId = 1;

function pageTimer(handle) {
  const { callback, ms, repeat } = handle;
  handle.page = repeat ? setInterval(callback, ms) : setTimeout(() => {
    handles.delete(handle.id);
    callback();
  }, ms);
}

function onWorkerFailed(error) {
  // oxlint-disable-next-line no-console
  console.warn(`transport timers: worker failed (${error?.message ?? error}); using the page's timers`);
  worker?.terminate();
  worker = undefined;
  for (const handle of handles.values()) {
    if (handle.page === undefined) pageTimer(handle);
  }
}

/**
 * Starts the timer worker from `url` (a classic script: timer-worker.js),
 * checked against `integrity` first (a Worker cannot be given one; the
 * fetch puts the checked script in the cache it is started from, as the
 * app's SQL worker). Resolves once it runs; never rejects: without it the
 * page's timers are used.
 */
export async function startTimerWorker({ url, integrity }) {
  if (worker || typeof Worker !== 'function') return;
  try {
    const response = await fetch(url, { integrity, credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.arrayBuffer();
    const started = new Worker(url, { name: 'transport timers' });
    started.onmessage = ({ data: id }) => {
      const handle = handles.get(id);
      if (!handle) return;
      if (!handle.repeat) handles.delete(id);
      handle.callback();
    };
    started.onerror = event => {
      event.preventDefault?.();
      if (worker === started) onWorkerFailed(event.message ?? event);
    };
    worker = started;
  } catch (error) {
    onWorkerFailed(error);
  }
}

function set(callback, ms, repeat) {
  const handle = { id: nextId++, callback, ms: Math.max(0, Number(ms) || 0), repeat };
  handles.set(handle.id, handle);
  if (worker) {
    worker.postMessage({ set: handle.id, ms: handle.ms, repeat });
  } else {
    pageTimer(handle);
  }
  return handle.id;
}

function clear(id) {
  const handle = handles.get(id);
  if (!handle) return;
  handles.delete(id);
  if (handle.page !== undefined) {
    clearTimeout(handle.page);
    clearInterval(handle.page);
  } else {
    worker?.postMessage({ clear: id });
  }
}

/** Like setTimeout, kept on time in a hidden page; returns an id for clearUnthrottled. */
export function setUnthrottledTimeout(callback, ms) {
  return set(callback, ms, false);
}

/** Like setInterval, kept on time in a hidden page; returns an id for clearUnthrottled. */
export function setUnthrottledInterval(callback, ms) {
  return set(callback, ms, true);
}

/** Cancels a timeout or interval set here. */
export function clearUnthrottled(id) {
  clear(id);
}
