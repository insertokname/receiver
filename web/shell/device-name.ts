// SPDX-License-Identifier: AGPL-3.0-only
//
// The name this device gets in the phone's list of linked devices, like
// WhatsApp Web's "Chrome (Linux)": "receiver (Chrome, Linux)". Desktop
// names a linked device after its operating system (OS.getName(), see
// ts/util/os/osPreload.web.ts). From the browser's client hints where
// available, else from the user agent string; never empty, and well under
// Desktop's limit (MAX_DEVICE_NAME_LENGTH, 50).

const APP = 'receiver';

type UserAgentData = {
  brands?: ReadonlyArray<{ brand: string }>;
  platform?: string;
};

// Client hint brands (GREASE entries like "Not.A/Brand" are ignored).
const BRANDS: ReadonlyArray<[RegExp, string]> = [
  [/^Microsoft Edge$/, 'Edge'],
  [/^Opera( GX)?$/, 'Opera'],
  [/^Brave$/, 'Brave'],
  [/^Vivaldi$/, 'Vivaldi'],
  [/^Samsung Internet$/, 'Samsung Internet'],
  [/^(Google Chrome|HeadlessChrome)$/, 'Chrome'],
  [/^Chromium$/, 'Chromium'],
];

// User agent strings, most specific first.
const UA_BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\b(OPR|OPT)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(Firefox|FxiOS)\//, 'Firefox'],
  [/\b(Chrome|CriOS|HeadlessChrome)\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const PLATFORMS: Record<string, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  android: 'Android',
  'chrome os': 'ChromeOS',
  chromeos: 'ChromeOS',
  'chromium os': 'ChromeOS',
  ios: 'iOS',
};

function browserName(ua: string, data: UserAgentData | undefined): string | undefined {
  for (const [pattern, name] of BRANDS) {
    if (data?.brands?.some(({ brand }) => pattern.test(brand))) {
      return name;
    }
  }
  return UA_BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];
}

function platformName(ua: string, data: UserAgentData | undefined, touchPoints: number): string | undefined {
  const hinted = data?.platform ? PLATFORMS[data.platform.toLowerCase()] : undefined;
  if (hinted) {
    return hinted;
  }
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) {
    return 'iOS';
  }
  if (/\bAndroid\b/.test(ua)) {
    return 'Android';
  }
  if (/\bCrOS\b/.test(ua)) {
    return 'ChromeOS';
  }
  if (/\bMacintosh\b/.test(ua)) {
    // iPadOS asks for desktop sites with a Mac user agent.
    return touchPoints > 1 ? 'iPadOS' : 'macOS';
  }
  if (/\bWindows\b/.test(ua)) {
    return 'Windows';
  }
  if (/\bLinux\b/.test(ua)) {
    return 'Linux';
  }
  return undefined;
}

export function deviceName(
  nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> & { userAgentData?: UserAgentData } = navigator
): string {
  const ua = nav.userAgent ?? '';
  const browser = browserName(ua, nav.userAgentData);
  const platform = platformName(ua, nav.userAgentData, nav.maxTouchPoints ?? 0);
  const details = [browser, platform].filter(Boolean).join(', ');
  return details ? `${APP} (${details})` : APP;
}
