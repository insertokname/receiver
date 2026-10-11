// SPDX-License-Identifier: AGPL-3.0-only

// Web build: Desktop runs its Linux code paths in the browser, and names a
// new linked device after OS.getName() ("Linux"). Here that name is the
// browser's, like WhatsApp Web's: "receiver (Chrome, macOS)". getName() is
// otherwise only used in messages about unsupported OS versions, which the
// web build never shows.

import { config } from '../../context/config.preload.ts';
import { getOSFunctions } from './shared.std.ts';
import { deviceName } from '../../../web/shell/device-name.ts';

const OS = { ...getOSFunctions(config.osRelease), getName: () => deviceName() };

export default OS;
