// SPDX-License-Identifier: AGPL-3.0-only
//
// Small DOM helpers for the app shell's own UI (styles in shell.css). The
// shell shows things Electron's main process shows in native dialogs, and
// things only a web app has ("Use here", the update and notification
// banners); they work before Desktop's renderer has loaded, so they are
// plain DOM, in English.

export const SOURCE_URL = 'https://github.com/insertokname/receiver';

type Child = Node | string;

export function h(
  tag: string,
  props: Record<string, string | ((event: Event) => void)> = {},
  ...children: Array<Child | null | undefined | false>
): HTMLElement {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'function') {
      element.addEventListener(key, value);
    } else if (key === 'class') {
      element.className = value;
    } else {
      element.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child != null && child !== false) {
      element.append(child);
    }
  }
  return element;
}

/** The "unofficial client" notice with a link to the source (AGPL). */
export function notice(): HTMLElement {
  return h(
    'p',
    {},
    'receiver is an unofficial client, not affiliated with Signal. ',
    h('a', { href: SOURCE_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Source code'),
    ' (AGPL-3.0).'
  );
}

export type ScreenButton = Readonly<{
  label: string;
  kind?: 'primary' | 'secondary' | 'danger';
  testId?: string;
  onClick: (button: HTMLButtonElement) => void;
}>;

export type ScreenOptions = Readonly<{
  id: string;
  title: string;
  text: ReadonlyArray<string>;
  buttons?: ReadonlyArray<ScreenButton>;
}>;

let currentScreen: HTMLElement | undefined;

/**
 * Shows a full-window screen over everything (replacing the previous one),
 * like the native dialogs Electron's main process shows instead of the
 * window. Returns a function that removes it.
 */
export function showScreen({ id, title, text, buttons = [] }: ScreenOptions): () => void {
  currentScreen?.remove();
  const buttonElements = buttons.map(button => {
    const element = h(
      'button',
      {
        type: 'button',
        class: `web-shell__button${button.kind && button.kind !== 'primary' ? ` web-shell__button--${button.kind}` : ''}`,
        ...(button.testId ? { 'data-testid': button.testId } : {}),
      },
      button.label
    ) as HTMLButtonElement;
    element.addEventListener('click', () => button.onClick(element));
    return element;
  });
  const screen = h(
    'div',
    { class: 'web-shell web-shell-screen', role: 'alertdialog', 'aria-modal': 'true', 'data-web-screen': id },
    h('div', { class: 'web-shell-screen__logo', 'aria-hidden': 'true' }),
    h('h1', { class: 'web-shell-screen__title' }, title),
    ...text.map(paragraph => h('p', { class: 'web-shell-screen__text' }, paragraph)),
    buttonElements.length ? h('div', { class: 'web-shell-screen__buttons' }, ...buttonElements) : null,
    h('div', { class: 'web-shell-screen__footer' }, notice())
  );
  document.body.append(screen);
  currentScreen = screen;
  buttonElements[0]?.focus();
  document.documentElement.dataset.webScreen = id;
  return () => {
    screen.remove();
    if (currentScreen === screen) {
      currentScreen = undefined;
      delete document.documentElement.dataset.webScreen;
    }
  };
}

export type DesktopView = 'loading' | 'waiting' | 'install' | 'inbox' | 'other';

/**
 * What Desktop shows: still loading; nothing yet after startApp (a new
 * device's link screen waits for Tor, see web/main/index.ts); the link
 * screen; the inbox.
 */
export function desktopView(): DesktopView {
  const state = window.reduxStore?.getState() as
    | { app?: { appView?: string }; installer?: { step?: string } }
    | undefined;
  const appView = state?.app?.appView;
  if (!appView || appView === 'Blank') {
    return document.documentElement.dataset.boot === 'startApp' && appView === 'Blank' ? 'waiting' : 'loading';
  }
  if (appView === 'Installer') {
    return state?.installer?.step === 'NotStarted' ? 'waiting' : 'install';
  }
  return appView === 'Inbox' ? 'inbox' : 'other';
}

/** Calls `fn` now and every second; Desktop's UI has no events for the shell. */
export function everySecond(fn: () => void): void {
  fn();
  setInterval(fn, 1000);
}
