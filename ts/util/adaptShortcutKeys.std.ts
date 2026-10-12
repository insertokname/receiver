// SPDX-License-Identifier: AGPL-3.0-only

// The keys the shortcut guide shows for a shortcut. Desktop: as listed. The
// web build's sibling (adaptShortcutKeys.web.ts) adds the modifier its app
// shortcuts take in a browser tab.

export function adaptShortcutKeys<Key extends string>(
  keys: ReadonlyArray<Key>
): ReadonlyArray<Key | 'ctrlOrAlt'> {
  return keys;
}
