// SPDX-License-Identifier: AGPL-3.0-only
// @indutny/mac-screen-share (macOS native screen capture): not in the web build.

import { unavailable } from '../node/unavailable.ts';

export const isSupported = false;
export const Stream = unavailable('@indutny/mac-screen-share', 'Stream');
export default { isSupported, Stream };
