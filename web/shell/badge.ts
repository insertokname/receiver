// SPDX-License-Identifier: AGPL-3.0-only
//
// The unread count outside the page, like WhatsApp Web: in the tab title
// ("(3) receiver"), on the tab's icon (Signal Desktop's tray icon badge: a
// red circle with the count, "9+" above nine) and, for the installed app, on
// its dock or taskbar icon (the Badging API, where the browser has it).
// Desktop reports the count it would show on its own icon (set-badge-count,
// web/main/channels.ts), after its settings (muted chats, chats or messages).

const ICON_URL = './favicon.svg';
const SIZE = 64;
// images/tray-icons/alert/*.png
const BADGE_COLOR = '#f44336';

let icon: Promise<HTMLImageElement> | undefined;
let shown = 0;

function loadIcon(): Promise<HTMLImageElement> {
  icon ??= new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => {
      icon = undefined;
      reject(new Error('the icon did not load'));
    };
    image.src = new URL(ICON_URL, document.baseURI).href;
  });
  return icon;
}

function iconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }
  return link;
}

async function drawIcon(count: number): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d canvas');
  context.drawImage(await loadIcon(), 0, 0, SIZE, SIZE);
  const text = count > 9 ? '9+' : String(count);
  const radius = SIZE * 0.3;
  const x = SIZE - radius;
  const y = radius;
  context.beginPath();
  context.arc(x, y, radius, 0, 2 * Math.PI);
  context.fillStyle = BADGE_COLOR;
  context.fill();
  context.fillStyle = '#ffffff';
  context.font = `600 ${Math.round(radius * (text.length > 1 ? 1.15 : 1.45))}px Inter, system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, x, y + radius * 0.08);
  return canvas.toDataURL('image/png');
}

function setTitle(count: number): void {
  // Desktop sets "receiver (3)" itself right after reporting the count.
  queueMicrotask(() => {
    const base = document.title.replace(/^\(\d+\) /, '').replace(/ \(\d+\)$/, '');
    document.title = count > 0 ? `(${count}) ${base}` : base;
  });
}

export function setUnreadBadge(count: number): void {
  const n = Number.isSafeInteger(count) && count > 0 ? count : 0;
  setTitle(n);
  const navigatorWithBadge = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  (n > 0 ? navigatorWithBadge.setAppBadge?.(n) : navigatorWithBadge.clearAppBadge?.())?.catch(() => undefined);
  if (n === shown) return;
  shown = n;
  const link = iconLink();
  if (n === 0) {
    link.removeAttribute('type');
    link.href = ICON_URL;
    return;
  }
  drawIcon(n).then(
    url => {
      // A later count may have been drawn first.
      if (shown !== n) return;
      link.type = 'image/png';
      link.href = url;
    },
    error => {
      // oxlint-disable-next-line no-console
      console.warn('web shell: no unread badge on the icon:', error?.message);
    }
  );
}
