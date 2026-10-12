// SPDX-License-Identifier: AGPL-3.0-only
//
// Keyboard shortcuts in a browser tab, like WhatsApp Web: the browser's own
// shortcuts stay the browser's (Cmd+1 switches tabs, Cmd+R reloads, ...),
// and the app's shortcuts take one more modifier: Desktop's Cmd+<key>
// (Ctrl+<key> on Windows and Linux) is Cmd+Ctrl+<key> on macOS and
// Ctrl+Alt+<key> elsewhere. Text editing keeps Desktop's keys: copy, paste,
// undo and select all everywhere, bold/italic/monospace/strikethrough/
// spoiler in the composer. Keys that are not characters (arrows, Enter,
// Home, ...) are unchanged.
//
// A listener on the window in the capture phase sees every key press
// before Desktop's handlers: a browser shortcut is kept from them (the
// browser then does what it does), and an app shortcut is passed on to them
// without the extra modifier, as Desktop expects it.

export function isMacPlatform(): boolean {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform;
  return /^mac/i.test(platform);
}

/** Desktop's Cmd/Ctrl shortcuts that edit text and keep their keys on the web. */
export function isEditingShortcut(key: string, shift: boolean, inText: boolean): boolean {
  const k = key.toLowerCase();
  if (!shift ? 'acvxzy'.includes(k) : 'zv'.includes(k)) return true;
  // The composer's formatting.
  return inText && (!shift ? 'bie'.includes(k) : 'xb'.includes(k));
}

function isText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

const passedOn = new WeakSet<Event>();

export function installKeyboardShortcuts(): void {
  const mac = isMacPlatform();

  window.addEventListener(
    'keydown',
    event => {
      if (passedOn.has(event) || event.isComposing) return;
      const mod = mac ? event.metaKey : event.ctrlKey;
      const extra = mac ? event.ctrlKey : event.altKey;
      const character = event.key.length === 1;

      if (!mod) {
        // Ctrl+Tab and Ctrl+Shift+Tab switch the browser's tabs.
        if (event.key === 'Tab' && event.ctrlKey) event.stopImmediatePropagation();
        return;
      }
      if (!extra) {
        if (character ? isEditingShortcut(event.key, event.shiftKey, isText(event.target)) : !['Tab', 'PageUp', 'PageDown'].includes(event.key)) {
          return;
        }
        // The browser's.
        event.stopImmediatePropagation();
        return;
      }
      // AltGr (Ctrl+Alt on Windows) types characters.
      if (event.getModifierState('AltGraph')) return;
      // The app's: Desktop gets it without the extra modifier.
      event.preventDefault();
      event.stopImmediatePropagation();
      const desktopEvent = new KeyboardEvent(event.type, {
        key: event.key,
        code: event.code,
        location: event.location,
        repeat: event.repeat,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: mac ? false : event.ctrlKey,
        altKey: mac ? event.altKey : false,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      passedOn.add(desktopEvent);
      (event.target ?? document).dispatchEvent(desktopEvent);
    },
    { capture: true }
  );
}
