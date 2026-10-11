// SPDX-License-Identifier: AGPL-3.0-only
//
// Desktop notifications, the way WhatsApp Web asks for them: never a
// permission prompt on load, but a dismissible banner in the inbox, "Get
// notified of new messages - Turn on desktop notifications". The browser's
// prompt only comes when the user clicks it.
//
// Desktop's notification service (ts/services/notifications.preload.ts)
// already uses the browser's Notification API on Linux, which the web
// build reports; clicking a notification calls the 'show-window' IPC
// (focuses this tab, web/main/channels.ts) and opens the conversation.
// They work while the tab is open, also in the background.

import { getStored, setStored } from '../main/storage.ts';
import { desktopView, everySecond, h } from './ui.ts';

const DISMISSED_KEY = 'notificationsBannerDismissed';

export function installNotificationBanner(): void {
  if (typeof Notification !== 'function') {
    return;
  }
  let banner: HTMLElement | undefined;
  let requesting = false;

  const hide = () => {
    banner?.remove();
    banner = undefined;
  };

  const turnOn = async () => {
    requesting = true;
    try {
      await Notification.requestPermission();
    } catch {
      // Old callback-only implementations: the state is read below anyway.
    } finally {
      requesting = false;
    }
    hide();
  };

  const dismiss = () => {
    setStored(DISMISSED_KEY, true);
    hide();
  };

  everySecond(() => {
    const show =
      Notification.permission === 'default' &&
      getStored<boolean>(DISMISSED_KEY) !== true &&
      desktopView() === 'inbox' &&
      document.documentElement.dataset.webScreen == null;
    if (!show) {
      if (!requesting) {
        hide();
      }
      return;
    }
    if (banner) {
      return;
    }
    const link = h(
      'button',
      { type: 'button', class: 'web-shell-banner__link', 'data-testid': 'notifications-turn-on' },
      'Turn on desktop notifications'
    );
    link.addEventListener('click', () => void turnOn());
    const close = h(
      'button',
      { type: 'button', class: 'web-shell-banner__close', 'aria-label': 'Dismiss', 'data-testid': 'notifications-dismiss' },
      '×'
    );
    close.addEventListener('click', dismiss);
    banner = h(
      'div',
      { class: 'web-shell web-shell-banner', role: 'region', 'aria-label': 'Notifications', 'data-web-banner': 'notifications' },
      h('div', { class: 'web-shell-banner__text' }, h('strong', {}, 'Get notified of new messages'), link),
      close
    );
    document.body.append(banner);
  });
}
