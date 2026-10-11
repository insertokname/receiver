// SPDX-License-Identifier: AGPL-3.0-only
//
// Placeholder start page: bootstrap Tor, open Signal's provisioning socket,
// report each step. The state is mirrored in <html data-state> for tests:
// starting -> bootstrapping -> connected -> provisioned (or retrying).

import { backoffDelay, connectTor, errorReason, onTransportLog, sleep } from './transport/index.js';
import { receiveProvisioningAddress } from './lib/signal.js';

const statusEl = document.getElementById('status');
const transportEl = document.getElementById('transport');
const eventsEl = document.getElementById('events');
const MAX_EVENTS = 12;
const started = performance.now();

function setState(state, text) {
  document.documentElement.dataset.state = state;
  statusEl.textContent = text;
}

function addEvent(text, kind = 'info') {
  const item = document.createElement('li');
  item.className = kind;
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  item.textContent = `${seconds}s  ${text}`;
  eventsEl.append(item);
  while (eventsEl.children.length > MAX_EVENTS) eventsEl.firstElementChild.remove();
  console.log(`[receiver] ${text}`);
}

function onTorEvent(event) {
  switch (event.type) {
    case 'attempt':
      setState('bootstrapping', `Connecting to Tor via ${event.transport.label}…`);
      addEvent(`trying ${event.transport.label}`);
      break;
    case 'failed':
      addEvent(`${event.transport.label} failed after ${event.seconds.toFixed(1)}s: ${event.reason}`, 'error');
      break;
    case 'connected':
      addEvent(`Tor circuit ready via ${event.transport.label} (${event.seconds.toFixed(1)}s)`, 'ok');
      break;
    case 'backoff':
      setState('retrying', `Could not reach Tor. Trying again in ${Math.round(event.delayMs / 1000)}s…`);
      addEvent(`all transports failed, retrying in ${Math.round(event.delayMs / 1000)}s`, 'error');
      break;
  }
}

onTransportLog((level, target, message) => {
  if (/WARN|ERROR/i.test(level)) console.warn(`[webtor] ${level} ${target}: ${message}`);
});

async function main() {
  for (let round = 1; ; round++) {
    const { client, transport } = await connectTor({ onEvent: onTorEvent });
    transportEl.textContent = `Connected to Tor via ${transport.label}.`;
    let failure;
    try {
      setState('connected', "Connected to Tor. Opening Signal's device-linking connection…");
      const opened = performance.now();
      const { socket, verb, path } = await receiveProvisioningAddress(client);
      const seconds = ((performance.now() - opened) / 1000).toFixed(1);
      addEvent(`Signal sent a provisioning address (${verb} ${path}, ${seconds}s)`, 'ok');
      await socket.close().catch(() => {});
    } catch (error) {
      failure = error;
    } finally {
      await client.close().catch(() => {});
    }
    if (!failure) {
      setState('provisioned', 'Provisioning address received from Signal through Tor. Linking a device is not available yet.');
      return;
    }
    const delayMs = backoffDelay(round);
    addEvent(`Signal connection failed: ${errorReason(failure)}`, 'error');
    setState('retrying', `Could not reach Signal. Trying again in ${Math.round(delayMs / 1000)}s…`);
    await sleep(delayMs);
  }
}

main().catch(error => {
  setState('error', `Stopped: ${errorReason(error)}. Reload the page to try again.`);
  addEvent(errorReason(error), 'error');
});
