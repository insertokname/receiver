// SPDX-License-Identifier: AGPL-3.0-only

// Web build: Desktop's Cmd/Ctrl shortcuts take Ctrl (macOS) or Alt as well,
// so that the browser keeps its own (web/shell/keyboard.ts); text editing
// and keys that are not characters keep Desktop's keys.

import { isEditingShortcut } from '../../web/shell/keyboard.ts';

const NOT_CHARACTERS = new Set(['enter', 'tab', 'F6', 'F10', 'F12', '↑', '↓']);

export function adaptShortcutKeys<Key extends string>(
  keys: ReadonlyArray<Key>
): ReadonlyArray<Key | 'ctrlOrAlt'> {
  const main = keys[keys.length - 1];
  if (keys[0] !== 'commandOrCtrl' || main === undefined || NOT_CHARACTERS.has(main)) {
    return keys;
  }
  const shift = keys.some(key => key === 'shift');
  if (main.length === 1 && isEditingShortcut(main, shift, true)) {
    return keys;
  }
  return ['commandOrCtrl', 'ctrlOrAlt', ...keys.slice(1)];
}
