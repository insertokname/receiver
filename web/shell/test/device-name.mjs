// SPDX-License-Identifier: AGPL-3.0-only
//
// The linked device's name (shell/device-name.ts) for common browsers.
//
//   node shell/test/device-name.mjs

import { deviceName } from '../device-name.ts';

const CASES = [
  [{ userAgentData: { brands: [{ brand: 'Not.A/Brand' }, { brand: 'Chromium' }, { brand: 'Google Chrome' }], platform: 'Linux' }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36' }, 'receiver (Chrome, Linux)'],
  [{ userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }], platform: 'Windows' }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0' }, 'receiver (Edge, Windows)'],
  [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:140.0) Gecko/20100101 Firefox/140.0' }, 'receiver (Firefox, macOS)'],
  [{ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' }, 'receiver (Firefox, Linux)'],
  [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15' }, 'receiver (Safari, macOS)'],
  [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15', maxTouchPoints: 5 }, 'receiver (Safari, iPadOS)'],
  [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1' }, 'receiver (Safari, iOS)'],
  [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/152.0 Mobile/15E148 Safari/604.1' }, 'receiver (Chrome, iOS)'],
  [{ userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Google Chrome' }], platform: 'Android' }, userAgent: 'Mozilla/5.0 (Linux; Android 10; K) Chrome/152.0.0.0 Mobile Safari/537.36' }, 'receiver (Chrome, Android)'],
  [{ userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Google Chrome' }], platform: 'Chrome OS' }, userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/152.0.0.0 Safari/537.36' }, 'receiver (Chrome, ChromeOS)'],
  [{ userAgent: '' }, 'receiver'],
];

let failed = 0;
for (const [nav, expected] of CASES) {
  const actual = deviceName({ maxTouchPoints: 0, ...nav });
  const ok = actual === expected && actual.length <= 50;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${actual}${ok ? '' : ` (expected ${expected})`}`);
}
console.log(failed ? 'DEVICE NAME FAIL' : `DEVICE NAME PASS (${CASES.length} cases)`);
process.exit(failed ? 1 : 0);
