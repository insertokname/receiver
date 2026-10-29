// SPDX-License-Identifier: AGPL-3.0-only
//
// The transport's timer worker (see timers.js): runs timeouts and intervals
// for the page and posts each one's id back when it fires. A dedicated
// worker's timers are not throttled with a hidden page's.

const timers = new Map();

onmessage = ({ data }) => {
  if (data.clear !== undefined) {
    clearTimeout(timers.get(data.clear));
    timers.delete(data.clear);
    return;
  }
  const { set: id, ms, repeat } = data;
  if (repeat) {
    timers.set(id, setInterval(() => postMessage(id), ms));
  } else {
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        postMessage(id);
      }, ms)
    );
  }
};
