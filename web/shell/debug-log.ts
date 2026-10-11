// SPDX-License-Identifier: AGPL-3.0-only
//
// The debug log view (Help > Debug log in Desktop, a window of its own in
// Electron): the log the app keeps in memory, already redacted, with "Copy"
// and "Save as file". Nothing is uploaded. The link screen has a small
// "Problems linking?" link to it, since that is where help is needed before
// Desktop's menus exist.

import { collectDebugLog } from '../main/debug-log.ts';
import { desktopView, everySecond, h } from './ui.ts';

let open: HTMLElement | undefined;

function fileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `receiver-debug-log-${stamp}.txt`;
}

function save(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = h('a', { href: url, download: fileName() });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Opens the debug log view (once). */
export function showDebugLog(): void {
  if (open) return;
  let text = '';
  const status = h('span', { class: 'web-shell-debuglog__status', role: 'status', 'aria-live': 'polite' });
  const area = h('textarea', {
    class: 'web-shell-debuglog__text',
    readonly: '',
    spellcheck: 'false',
    'aria-label': 'Debug log',
    'data-testid': 'debug-log-text',
  }) as HTMLTextAreaElement;
  area.value = 'Loading...';
  const button = (label: string, testId: string, onClick: () => void, kind = '') =>
    h(
      'button',
      { type: 'button', class: `web-shell__button${kind}`, 'data-testid': testId, disabled: '', click: onClick },
      label
    ) as HTMLButtonElement;
  const close = () => {
    dialog.remove();
    open = undefined;
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };
  const copy = button('Copy', 'debug-log-copy', () => {
    navigator.clipboard.writeText(text).then(
      () => {
        status.textContent = 'Copied.';
      },
      () => {
        area.select();
        status.textContent = 'Could not copy: select the text and copy it.';
      }
    );
  });
  const saveButton = button('Save as file', 'debug-log-save', () => {
    save(text);
    status.textContent = 'Saved.';
  });
  const closeButton = button('Close', 'debug-log-close', close, ' web-shell__button--secondary');
  closeButton.disabled = false;
  const dialog = h(
    'div',
    { class: 'web-shell web-shell-debuglog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Debug log', 'data-web-dialog': 'debug-log' },
    h(
      'div',
      { class: 'web-shell-debuglog__panel' },
      h('h1', { class: 'web-shell-debuglog__title' }, 'Debug log'),
      h(
        'p',
        { class: 'web-shell-debuglog__hint' },
        'What receiver logged recently, with phone numbers, ids and keys removed. It stays on this device: copy it or save it to share it with someone helping you.'
      ),
      area,
      h('div', { class: 'web-shell-debuglog__buttons' }, status, closeButton, copy, saveButton)
    )
  );
  document.body.append(dialog);
  document.addEventListener('keydown', onKey);
  open = dialog;
  closeButton.focus();
  collectDebugLog().then(
    log => {
      text = log;
      area.value = log;
      area.scrollTop = area.scrollHeight;
      copy.disabled = false;
      saveButton.disabled = false;
    },
    error => {
      area.value = `Could not collect the debug log: ${String((error as Error)?.message ?? error)}`;
    }
  );
}

/** A "Problems linking?" link under the link screen. */
export function installDebugLogLink(): void {
  const link = h(
    'button',
    { type: 'button', class: 'web-shell-debuglog-link', 'data-testid': 'debug-log-link', click: () => showDebugLog() },
    'Problems linking? Save the debug log'
  );
  everySecond(() => {
    const show = desktopView() === 'install' && document.documentElement.dataset.webScreen == null;
    if (show && !link.isConnected) document.body.append(link);
    else if (!show && link.isConnected) link.remove();
  });
}
